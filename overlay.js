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
 * 字体（v64）：字族/字号跟随客户端 —— font-family 一律 var(--font-mono, 旧硬编码栈兜底)
 *       （客户端 ：root 上的等宽令牌，macOS 解析为 SF Mono，含中文回退）；字号一律
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
  var MY_GEN = (window.__zusageGen = (window.__zusageGen || 0) + 1);
  function stale() { return disposed || MY_GEN !== window.__zusageGen; }
  if (window.__zusageRateCleanup) window.__zusageRateCleanup();

  var FATAL = (window.__zusageDiag = {});
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
    document.querySelectorAll(".zusage-root,.zusage-tip-root,.zusage-exc,.zusage-rate-tip,.zusage-quota-tip,.zu-quota,.zu-git,.zu-tsb,.zu-compact-btn,.zu-ac-info,.zu-ac-hint,.zu-compact-dlg,.zusage-git-tip,.zusage-panel,.zu-mp-host,.zu-mp-ov,[data-zusage-deterministic],[data-zusage-loading-status]").forEach(function (el) { el.remove(); });
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
  var LS = { show: "zusage3.show", ctxOv: "zusage3.ctxOv", lang: "zusage3.lang", cnNum: "zusage3.cnNum", sec: "zusage3.sec", rstCdh: "zusage3.rstCdh", projPath: "zusage3.projPath", theme: "zusage3.theme", ctxEnh: "zusage3.ctxEnh", cmdkW: "zusage3.cmdkW", updSeen: "zusage3.updSeen", forceKmb: "zusage3.forceKmb", ctxCpt: "zusage3.ctxCpt", cost: "zusage3.cost", barJust: "zusage3.barJust", autoCompact: "zusage3.autoCompact", tipClick: "zusage3.tipClick", quotaRemain: "zusage3.quotaRemain" };
  var state = {
    show: { win: 1, turn: 1, today: 1, sub: 1, tools: 1, git: 1, proj: 1, subRate: 1 },   // git：工具行 Git 状态 chip（v96，默认开）；proj：项目累计格（v159，默认开；与 zusage3.projPath 弹窗路径开关无关）；subRate：Agent 行内子代理速率 chip（v178，默认开；只门控行内展示，槽位估算与主 chip 合计不受影响）
    ctxOv: "", data: null,
    lang: "zh", theme: "default", pluginUpdate: window.__zusagePluginState || null,
    /* v226 默认样式水平对齐：between|start|end（均分/居左/居右），仅默认档生效；药丸恒 flex-start */
    barJust: "between",
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
    lsSet(LS.rstCdh, String(state.resetCdh));
    lsSet(LS.sec, state.settingsSec);
  }

  /* ---------- 多实例注册表（v61.1）：每个分屏 pane 一个条实例 ---------- */
  var instances = [];   // spawnInstance 返回的 api：{pid, attach, render, ...}
  var nextSlot = 0;     // 实例序号；0 号保留兼容 id（#zusage-bar，泵热更新按它清理）
  /* v268：粘性升级 window 级跨代际——热重载/重启后新实例直接继承上一代轮表。
   * v255 的代际内粘性在新代际首帧恰逢 serve 空闲回收/重启窗口（帧缺 speed_history）时
   * 为空，速度 Tooltip 闪回旧版整卡（用户实报「现在变成老版本了」；本地 json 链实测
   * 1268 轮/197 会话产出正常，serve pid 数分钟内 8576→11362 证实频繁回收重启）。
   * 轮表是历史统计，分钟级陈旧可接受（v257 同取舍），下一帧成功即覆盖。 */
  var lastSpeedHistory = (typeof window !== "undefined" && window.__zusageSpdSticky) || null;
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
    if (stale() || !d || d.error) return;
    /* v255：粘性统一轮表。常驻 serve 重启/空闲回收时主进程会回退到一次性 json，
     * 那一帧可能缺 speed_history；沿用本代最近一份有界轮表，速度 Tooltip 不再
     * 在 V2 与旧版整卡之间闪回。首帧尚无轮表（旧 Python/查询失败）才回退旧布局。 */
    if (d.speed_history && d.speed_history.turns && d.speed_history.turns.length) {
      lastSpeedHistory = d.speed_history;
      try { window.__zusageSpdSticky = lastSpeedHistory; } catch (_) { }
      FATAL.spdFrame = { t: Date.now(), has: 1, sticky: 0, turns: d.speed_history.turns.length };   // v257 帧级诊断
    } else {
      var stickyHit = !d.speed_history && typeof lastSpeedHistory !== "undefined" && lastSpeedHistory;
      if (stickyHit) d.speed_history = lastSpeedHistory;
      /* v257 帧级诊断：缺字段/None 帧记 0，粘性补帧记 1——再出现象时 diag 直接可定位是
       * 数据链缺帧还是粘性未建立，不再靠截图反推。原地更新不替换对象（FATAL 共享引用）。 */
      FATAL.spdFrame = { t: Date.now(), has: 0, sticky: stickyHit ? 1 : 0, turns: 0 };
    }
    if (d.remote_today) for (var key in d.remote_today) {
      if (d.remote_today[key] && typeof d.remote_today[key] === "object") {
        remoteTodayCache[key] = d.remote_today[key];
        var tks = Object.keys(remoteTodayCache);
        if (tks.length > 64) delete remoteTodayCache[tks[0]];
      }
    }
    state.data = d;
    for (var i = 0; i < instances.length; i++) {
      try { instances[i].render(d); } catch (e) { FATAL.updateErr = String((e && e.stack) || e); }
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
  window.__zusagePluginResult = function (result) {
    if (!result || typeof result.id !== "string") return;
    var done = pluginRequestCallbacks[result.id];
    if (!done) return;
    delete pluginRequestCallbacks[result.id];
    try { done(result); } catch (e) { FATAL.pluginResultErr = "result handler failed"; }
  };
  /* ---------- Git 状态 chip 数据通道（v96）：主进程旁路 git 查询 → 按工作区路径缓存 ----------
   * 主进程每 10s 取各窗口 window.__zusageGitPaths 并集逐路径查询，结果推 window.__zusageGitState；
   * 渲染端只缓存与分发，实例按自身 scope.workspacePath 取用。失败不清空最近成功态（标 stale），
   * 只有明确「非仓库 / 无 git」才视为无数据不挂载。 */
  var gitStateByPath = {}, gitLastGood = {}, gitAskedAt = 0;
  var GIT_ASK_MIN_MS = 5000;
  function gitViewFor(p) {
    var cur = gitStateByPath[p];
    if (!cur) return null;
    if (cur.ok) return { st: cur, stale: false };
    if (cur.reason === "notrepo" || cur.reason === "nogit") return null;
    var good = gitLastGood[p];
    return good ? { st: good, stale: true } : null;
  }
  function askGitRefresh(force, done, path) {
    var paths = window.__zusageGitPaths;
    if (!paths || !paths.length) return "";
    var now = Date.now();
    if (!force && now - gitAskedAt < GIT_ASK_MIN_MS) return "";
    gitAskedAt = now;
    return pluginRequest("git-refresh", typeof path === "string" ? { path: path } : undefined, done);
  }
    window.__zusageGitState = function (p, st) {
      if (stale() || typeof p !== "string" || !st || typeof st !== "object") return;
      gitStateByPath[p] = st;
      if (st.ok) gitLastGood[p] = st;
      for (var i = 0; i < instances.length; i++) {
        try { instances[i].gitTouch(); } catch (e) { FATAL.gitErr = String((e && e.stack) || e); }
      }
    };
  window.__zusagePluginUpdate = function (s) {
    if (stale() || JSON.stringify(state.pluginUpdate) === JSON.stringify(s)) return;
    window.__zusagePluginState = state.pluginUpdate = s;
    if (s && typeof s.rateLine === "boolean") state.rateLine = s.rateLine;
    if (s && typeof s.quotaEnabled === "boolean") state.quotaEnabled = s.quotaEnabled;
    if (s && typeof s.resetBadgeEnabled === "boolean") state.resetBadge = s.resetBadgeEnabled;   // v135
    if (s && typeof s.restartNotice === "boolean") state.restartNotice = s.restartNotice;   // v159（issue #139）
    if (s && s.enginePatch && typeof s.enginePatch === "object") state.enginePatch = s.enginePatch;   // v179：⚙ 状态行与 hover 阈值行的数据源
    if (s && Array.isArray(s.quotaSources)) state.quotaSources = s.quotaSources;   // v95：chip 门控随主进程真值（heavy 对账点内生效）
    scanRateLines();
    instances.forEach(function (inst) { inst.syncUpdate(); });
  };
  /* 工作区身份来自当前会话节点；共享 localStorage 不能证明本窗口的 pane 归属。 */
  function collectSidWs() {
    var map = {};
    for (var i = 0; i < instances.length; i++) {
      var inst = instances[i], sid = inst.getSid();
      var scope = inst.getScope && inst.getScope();
      if (!sid || !scope || scope.sid !== sid || !REMOTE_IDENTITY_RE.test(scope.identity)) continue;
      if (!map[sid]) map[sid] = [];
      if (map[sid].indexOf(scope.identity) < 0) map[sid].push(scope.identity);
    }
    return map;
  }
  /* 可信远端身份前缀白名单（与泵侧 REMOTE_IDENTITY_RE 同族）：ssh/wsl/docker/server。
   * v3.16 客户端把所有传输连接握手后统一升级为 remote:server:，wsl/docker 是直接传输身份。 */
  var REMOTE_IDENTITY_RE = /^remote:(?:ssh|wsl|docker|server):/;
  /* v258：静态桥缺席（客户端升级到 HOST_TARGETS 表外版本、桥未部署或 replace-failed）时
   * 的 SessionPane 归属兜底：宿主自写的 data-session-id 节点仍挂 React fiber，沿 return
   * 链上溯找 SessionPane 组件帧的 workspace/pane props（JSX 属性名不被压缩，renderer_bridge
   * AUTO_PANE_PARAM 同源证据）。只读、限深 24 层、途中撞上更外层的会话/分栏根立即止步，
   * 防跨 pane 读父容器 props；多候选值不一致按歧义拒绝（fail-closed）。下方校验与静态属性
   * 分支逐字同规（控制字符、remote/identity 互证、REMOTE_IDENTITY_RE）。 */
  function fiberPaneCandidates(root, pid) {
    var keys = Object.keys(root), fk = "";
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) { fk = keys[i]; break; }
    }
    if (!fk) return null;
    var fiber = root[fk], out = null, depth = 0;
    while (fiber && depth++ < 24) {
      var node = fiber.stateNode;
      if (node && node !== root && node.getAttribute &&
          (node.hasAttribute("data-session-id") || node.hasAttribute("data-pane-id"))) break;
      var p = fiber.memoizedProps || fiber.pendingProps;
      if (p && typeof p.workspacePath === "string" && p.workspacePath.trim()) {
        /* tabId 本身就以 selection-side-chat: 开头（v174 同源），实例 pid 即其全串，不再拼前缀 */
        var tabId = typeof p.tabId === "string" && p.tabId.indexOf("selection-side-chat:") === 0 ? p.tabId : "";
        if (p.paneId === pid || (pid && tabId === pid)) {
          var cand = { workspacePath: p.workspacePath,
            identity: typeof p.workspaceIdentity === "string" ? p.workspaceIdentity : "",
            remote: typeof p.remoteSessionId === "string" ? p.remoteSessionId : "" };
          if (!out) out = cand;
          else if (JSON.stringify(out) !== JSON.stringify(cand)) return null;   // 歧义拒绝
        }
      }
      fiber = fiber.return;
    }
    return out;
  }
  function readFiberPaneScope(root, sid, pid) {
    if (!root || !sid || sid === "draft" || !root.getAttribute ||
        root.getAttribute("data-session-id") !== sid) return null;
    try {
      var best = fiberPaneCandidates(root, pid);
      if (!best) return null;
      var path = best.workspacePath, identity = best.identity, remote = best.remote;
      if (!path.trim() || /[\x00-\x1f\x7f]/.test(path + identity + remote)) return null;
      identity = identity.trim();
      if (remote && (!identity || /\s/.test(remote))) return null;
      if (identity && !REMOTE_IDENTITY_RE.test(identity)) return null;
      return { sid: sid, identity: identity, workspacePath: path, remoteSessionId: remote };
    } catch (e) { return null; }
  }
  function readPaneScope(el, sid, pid) {
    if (!el || !sid || sid === "draft" || !el.isConnected) return null;
    try {
      var root = el;
      while (root && !(root.hasAttribute && root.hasAttribute("data-session-id"))) root = root.parentElement;
      if (!root || root.getAttribute("data-session-id") !== sid) return null;
      if (root.getAttribute("data-zusage-scope-version") !== "1") return readFiberPaneScope(root, sid, pid);   // v258：桥缺席的 fiber 兜底
      if (root.getAttribute("data-zusage-pane-id") !== pid) return null;
      var path = root.getAttribute("data-zusage-workspace-path");
      var identity = root.getAttribute("data-zusage-workspace-identity");
      var remote = root.getAttribute("data-zusage-remote-session-id");
      if (typeof path !== "string" || !path.trim() || typeof identity !== "string" ||
          typeof remote !== "string" || /[\x00-\x1f\x7f]/.test(path + identity + remote)) return null;
      identity = identity.trim();
      if (remote && (!identity || /\s/.test(remote))) return null;
      if (identity && !REMOTE_IDENTITY_RE.test(identity)) return null;
      return { sid: sid, identity: identity, workspacePath: path, remoteSessionId: remote };
    } catch (e) { return null; }
  }
  var quotaSelectionsSig = "";
  function reportQuotaSelections() {
    if (stale()) return;
    var panes = {};
    for (var i = 0; i < instances.length; i++) {
      var selection = instances[i].getQuotaSelection && instances[i].getQuotaSelection();
      if (selection) panes[instances[i].pid] = selection;
    }
    var sig = JSON.stringify(panes);
    if (sig === quotaSelectionsSig) return;
    quotaSelectionsSig = sig;
    FATAL.quotaSelections = { time: new Date().toISOString(), panes: panes };
    var queue = window.__zusagePluginRequests || [];
    for (var j = queue.length - 1; j >= 0; j--) if (queue[j].action === "quota-providers") queue.splice(j, 1);
    pluginRequest("quota-providers", { panes: panes });
  }
  function refreshWants() {
    try {
      var arr = [], panes = {};
      mainScopeNow = { sid: "", identity: "", known: false };
      for (var i = 0; i < instances.length; i++) {
        var inst = instances[i], sid = inst.getSid();
        if (!sid) continue;
        if (arr.indexOf(sid) < 0) arr.push(sid);
        var scope = inst.getScope && inst.getScope();
        if (!scope || scope.sid !== sid) scope = null;
        panes[inst.pid] = scope ? { sid: sid, identity: scope.identity } : { sid: sid };
        if (inst.pid === "workspace-main") mainScopeNow = { sid: sid, identity: scope ? scope.identity : "", known: !!scope };
      }
      window.__zusageWantSids = arr;
      window.__zusageWantSid = arr[0] || "";
      window.__zusageSidWs = collectSidWs();
      window.__zusagePaneScopes = panes;
      publishGitPaths();
    } catch (e) { }
  }
  /* v96：Git chip 关注的本地工作区路径集 → window.__zusageGitPaths（主进程每 10s 取并集查询）。
   * identity 为空才是本地；远端 pane 不上报（主进程不替宿主跨机跑 git）；开关关闭为空集。
   * 每次 render 都经 refreshWants 到这里：路径集变化立即请求首查，否则按快照节奏节流重查
   * （快照到达 = 刚有请求落库，模型可能刚改过文件）。 */
  function publishGitPaths() {
    try {
      var gitPaths = [];
      if (state.show.git) for (var i = 0; i < instances.length; i++) {
        var inst = instances[i], sid = inst.getSid();
        var scope = sid && inst.getScope ? inst.getScope() : null;
        if (scope && scope.sid === sid && !scope.identity && gitPaths.indexOf(scope.workspacePath) < 0) gitPaths.push(scope.workspacePath);
      }
      var changed = JSON.stringify(gitPaths) !== JSON.stringify(window.__zusageGitPaths || []);
      window.__zusageGitPaths = gitPaths;
      askGitRefresh(changed);
    } catch (e) { }
  }

  /* ---------- 回复末尾速率行的悬停解释（v67）：给消息流里的统计行挂同款 tooltip ----------
   * 统计行是模型贴的 Markdown 引用块（⚡ … tok/s(本轮)），本身没有 hover 能力；
   * 浮层是注入 DOM 的，所以由它扫描消息流、给匹配节点挂自绘 tooltip（与状态条同套路：
   * 挂 body 的 fixed 浮层，免疫消息流层叠上下文）。document 级、只此一份，不随 pane 实例走。 */
  var rateTip = document.createElement("div");
  rateTip.className = "tip zusage-rate-tip";
  /* .tip 的类样式挂在条实例的 <style> 里（样式随条走）——本浮层是 document 级的，
   * 实例销毁/重建的间隙会失去类样式。内联关键属性兜底（值与 .tip 类一致，含主题 var），
   * 类样式在位时两者相同、不冲突；display 由 show/hide 控制。 */
  rateTip.style.cssText =
    "position:fixed;display:none;background:var(--color-tooltip,#171717);" +
    "border:1px solid var(--color-border,transparent);border-radius:10px;padding:10px 14px;" +
    "font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);" +
    "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.55;color:var(--color-tooltip-foreground,#fafafa);" +
    "box-shadow:0 10px 28px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3);" +
    "white-space:normal;z-index:2147483646;max-width:520px;box-sizing:border-box";
  document.body.appendChild(rateTip);
  var rateTipFor = null;
  /* 结构化内容：样式内嵌本浮层（选择器带 .zusage-rate-tip 前缀，随元素清理），
   * 不依赖条实例的 <style>；全部为静态双语文案，无任何插值。 */
  function rateTipHTML() {
    var row = function (label, text) {
      return '<div class="rt-row"><b>' + label + "</b><span>" + text + "</span></div>";
    };
    return '<style>.zusage-rate-tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px}' +
      ".zusage-rate-tip .rt-row{display:flex;gap:10px;margin:3px 0}" +
      ".zusage-rate-tip .rt-row b{flex:0 0 auto;min-width:78px;color:var(--color-tooltip-foreground,#fafafa);font-weight:600}" +
      ".zusage-rate-tip .rt-row span{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      '.zusage-rate-tip .rt-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-border,transparent);color:var(--color-tooltip-tag-foreground,#a6a6a6)}</style>' +
      '<div class="rt-h">⚡ ' + L("本问速率 · 各数值含义", "Rate line · what each figure means") + "</div>" +
      row("token/s", L("本问各段加权平均：总输出 ÷ 总生成时长，工具等待不计入", "weighted average of all segments: total output ÷ total generation time, tool waits excluded")) +
      row(L("首字", "TTFT"), L("第一段从发出请求到首个 token 的等待", "wait from request to the first token of the first segment")) +
      row(L("输出", "Output"), L("本问各段输出合计（思考 token 已含其中）", "sum of segment output (thinking tokens already included)")) +
      row(L("生成", "Gen"), L("各段生成窗口合计：含思考（含 Claude 这类不单独上报思考的模型）用 completed_at − started_at；思考随首字后流出的供应商（按历史数据自动识别）思考已在首字窗口内，用 completed_at − first_token_at；不含段间工具等待", "sum of segment generation windows: with thinking (including models such as Claude that don't report it separately) use completed_at − started_at; for providers whose thinking streams after the first token (auto-detected from history) thinking is already inside the first-token window, so completed_at − first_token_at applies; tool waits between segments excluded")) +
      row(L("段 / 峰", "Seg/Peak"), L("段＝模型请求次数；峰＝最快一段的速率", "segments = model requests; peak = fastest segment")) +
      row(L("会话均", "Session avg"), L("本会话全部已完成请求的加权平均：总输出 ÷ 总生成时长（各段生成窗口求和，工具等待不计入；不含子代理）", "weighted average over all completed requests of this session: total output ÷ total generation time (sum of segment windows, tool waits excluded; sub-agents excluded)")) +
      row(L("累计", "Session"), L("本会话已完成请求的输出总量（不含子代理）", "cumulative output of completed requests (sub-agents excluded)")) +
      row("⏱", L("采样时刻——写正文前自测，收尾正文段未计入", "sample time — self-tested before the final text, so that segment is excluded")) +
      '<div class="rt-note">' + L("状态条「生成速度」是最近一段的瞬时值，与本行的整问均值不同，数值有差异属正常。⚙ 设置可关。",
        "The bar's \"generation speed\" is the latest segment's instant value; this line is the whole-answer average — a difference is expected. Toggle in ⚙ settings.") + "</div>";
  }
  function showRateTip(el) {
    if (stale() || !state.rateLine || !isRateLine(el)) { hideRateTip(); return; }
    rateTip.innerHTML = rateTipHTML();
    rateTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = rateTip.offsetWidth, th = rateTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;               // 优先弹在统计行上方
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);   // 上方放不下改下方
    rateTip.style.left = Math.round(left) + "px";
    rateTip.style.top = Math.round(top) + "px";
    rateTipFor = el;
  }
  function hideRateTip() {
    rateTip.style.display = "none";
    rateTipFor = null;
  }

  /* ---------- v96 套餐额度 chip 的悬停说明：rateTip 同款 document 级独立浮层 ----------
   * chip 挂在宿主工具栏（条外），状态条 .it 的 tooltip 事件委托覆盖不到它；mouseenter/
   * leave 自管理，内容按 chip.__zuQ（render 时写入的最近快照）在悬停时即时生成。 */
  var quotaTip = document.createElement("div");
  quotaTip.className = "tip zusage-quota-tip";
  quotaTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(quotaTip);
  var quotaTipFor = null;
  function qTime(v) {   // 统一 yyyy-MM-dd HH:mm；接受毫秒数或 ISO 字符串
    if (v == null || v === "") return "";
    var d = typeof v === "number" ? new Date(v) : new Date(String(v));
    if (isNaN(d.getTime())) return "";
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function qTimeS(v) {   // yyyy-MM-dd HH:mm:ss（重置卡 tooltip 专用：过期时刻精确到秒，其余 tooltip 不变）
    var base = qTime(v);
    if (!base) return "";
    var d = typeof v === "number" ? new Date(v) : new Date(String(v));
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return base + ":" + pad(d.getSeconds());
  }
  function quotaFamilyOf(provider) {   // 内置套餐家族：OAuth 的 account:* 与 apiKey 模式的 bigmodel-api[-N] / zai-api[-N]
    var p = String(provider || "");
    if (p.indexOf("account:bigmodel-start-plan") === 0 || p.indexOf("account:zai-start-plan") === 0) return "zcode-start";
    if (p.indexOf("account:zai") === 0 || /^zai-api(-\d+)?$/.test(p)) return "zai";
    if (p.indexOf("account:bigmodel") === 0 || /^bigmodel-api(-\d+)?$/.test(p)) return "bigmodel";
    return "";
  }
  function quotaFamilyLabel(provider) {
    var fam = quotaFamilyOf(provider);
    return fam === "zai" ? "Z.ai" : fam === "zcode-start" ? "ZCode Start Plan" : "BigModel";
  }
  function quotaLevelLabel(level) {
    var m = { max: "Max", pro: "Pro", lite: "Lite" };
    return m[String(level || "").toLowerCase()] || String(level || "");
  }
  function quotaRemainPct(pct) {   /* v251 剩余口径显示值：同一额度窗口的 100−已用，钳 [0,100]（取整交各显示处自行处理） */
    var r = 100 - pct;
    return r < 0 ? 0 : r > 100 ? 100 : r;
  }
  function quotaStatusText(st) {
    return {
      auth_failed: L("认证失效：重新登录 ZCode 后自动恢复", "Authentication failed: recovers after signing in to ZCode again"),
      rate_limited: L("接口限流，稍后自动重试", "Rate limited; retrying later"),
      network_error: L("网络错误，稍后自动重试", "Network error; retrying later"),
      parse_error: L("接口返回格式变化，已降低查询频率", "Unexpected response format; polling slowed down"),
      no_plan: L("当前账号未订阅编码套餐", "No coding plan on this account"),
    }[st] || "";
  }
    function quotaTipHTML(d) {
      var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
      var row = function (label, text) { return '<div class="rt-row"><b>' + label + "</b><span>" + text + "</span></div>"; };
      var css = '<style>.zusage-quota-tip .qt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px}' +
        ".zusage-quota-tip .rt-row{display:flex;gap:12px;margin:4px 0;align-items:flex-start}" +
        ".zusage-quota-tip .rt-row b{flex:0 0 86px;min-width:0;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500}" +
        ".zusage-quota-tip .rt-row span{min-width:0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}" +
        ".zusage-quota-tip .qt-cur{color:var(--color-tooltip-foreground,#fafafa);font-weight:600}" +
        ".zusage-quota-tip .qt-warn{color:#f5b944}" +
        '.zusage-quota-tip .qt-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent));color:var(--color-tooltip-tag-foreground,#a6a6a6);overflow-wrap:anywhere}</style>';
    if (d.mode.kind === "team") {
      return css + '<div class="qt-h">⊘ ' + L("团队套餐额度", "Team plan quota") + "</div>" +
        '<div class="qt-note">' + L("团队套餐需要组织/项目维度的查询，当前版本暂不支持；个人编码套餐已支持。", "Team plans need organization/project-scoped queries, which this version does not support yet; individual coding plans are supported.") + "</div>";
    }
    if (d.mode.kind === "info") {   // v111：未配置/暂不支持的中性说明（无数据可列，只给引导）
      var q0 = d.q || {};
      return css + '<div class="qt-h">' + L("套餐额度", "Plan quota") + "</div>" +
        '<div class="qt-note">' + (q0.status === "not_configured"
          ? L("未找到可用的登录凭据或 API Key；在 ⚙ 面板的额度源里配置后自动显示。", "No usable sign-in credentials or API key found; configure a quota source in the ⚙ panel and the chip fills in.")
          : L("该数据源的额度/余额形状暂不支持查询。", "This source's quota or balance shape is not supported yet.")) + "</div>";
    }
    var q = d.q || {};
    var isBalance = d.mode.kind === "balance";
    var rem = state.quotaRemain === 1;   // v251 显示口径跟随 ⚙「显示剩余额度」：剩余% 打头（与 chip 面同口径）
    var title = isBalance ? L("账户余额", "Account balance") : L("套餐额度", "Plan quota");
    /* 标题：有订阅元数据（productName/version/valid）时拼成一行；缺失回退 family+档位 */
    var pl = q.plan;
    /* 周期标签：renewAt=自动续费的下次扣费日（不是最终到期，宿主同款互斥语义）；
     * validEnd=非自动续费的当前权益结束日；两者都缺（周期无法确认）只显示套餐名。 */
    var periodLabel = pl && pl.renewAt
      ? L(" · 下次续费 ", " · renews ") + esc(pl.renewAt)
      : pl && pl.validEnd ? L(" · 有效期至 ", " · valid until ") + esc(pl.validEnd) : "";
    var head = (pl && (pl.productName || pl.version))
      ? [pl.productName, pl.version].filter(Boolean).map(esc).join(" · ") + periodLabel
      : esc(q.label || (String(d.provider || "").indexOf("account:") === 0 || quotaFamilyOf(d.provider) ? quotaFamilyLabel(d.provider) : L("自定义供应商", "Custom provider"))) +
        (q.level ? " " + esc(quotaLevelLabel(q.level)) : "");
    var out = css + '<div class="qt-h">' + title + " · " + head + "</div>";
    var w = q.windows || {};
    var winRow = function (label, e) {
      if (!e) return "";
      var pct = typeof e.percent === "number" ? (Math.round((rem ? quotaRemainPct(e.percent) : e.percent) * 10) / 10) + "%" : "—";
      var rs = qTime(e.resetsAt);
      /* 剩余口径下主数字与首位绝对值换为剩余（补数），已用退为带标签明细；两种口径信息等价只换顺序 */
      var detail = (e.used != null && e.total != null && e.remaining != null)
        ? " · " + quotaBalanceText({ amount: rem ? e.remaining : e.used, currency: e.currency }) + " / " +
          quotaBalanceText({ amount: e.total, currency: e.currency }) + " · " + (rem ? L("已用 ", "used ") : L("剩余 ", "remaining ")) +
          quotaBalanceText({ amount: rem ? e.used : e.remaining, currency: e.currency })
        : "";   // sub2api 等带金额明细的窗口拼进行内；BigModel 套餐窗只有百分比则不拼
      return row(label, (rem ? L("剩余 ", "remaining ") : L("已用 ", "used ")) + pct + detail + (rs ? " · " + (e.expires ? L("到期 ", "expires ") : L("重置 ", "resets ")) + rs : ""));
    };
    out += winRow(L("每日窗口", "Daily window"), w.daily) + winRow(L("5小时窗口", "5-hour window"), w.fiveHour) +
      winRow(L("本周窗口", "This week"), w.weekly) + winRow(L("月度窗口", "Monthly"), w.monthly) +
      winRow(L("套餐池", "Plan pool"), w.plan);
    if (q.quotaSummary) {
      var summary = q.quotaSummary;
      out += row(L("Key 总额度", "Key quota"), (rem ? L("剩余 ", "remaining ") : L("已用 ", "used ")) +
        quotaBalanceText({ amount: rem ? summary.remaining : summary.used, currency: summary.currency }) + " / " +
        quotaBalanceText({ amount: summary.limit, currency: summary.currency }) + " · " + (rem ? L("已用 ", "used ") : L("剩余 ", "remaining ")) +
        quotaBalanceText({ amount: rem ? summary.used : summary.remaining, currency: summary.currency }));
    }
    if (q.subscription && q.subscription.expiresAt) {
      out += row(L("订阅截止", "Subscription ends"), esc(q.subscription.expiresAt));
    }
    if (q.balance && typeof q.balance.amount === "number" && isFinite(q.balance.amount)) {
      /* quotaBalanceText 已自带转义；parts 的 label/amount 是远程字符串，逐项转义后拼接，
       * 整行不得再整体 esc（曾双重转义把 "A&B" 显示成 "A&amp;amp;B"）。 */
      var balTxt = quotaBalanceText(q.balance);
      if (q.balance.parts && q.balance.parts.length) {
        balTxt += "（" + q.balance.parts.map(function (pp) { return esc(pp.label) + " " + esc(pp.amount); }).join(" / ") + "）";
      }
      out += row(L("余额", "Balance"), balTxt);
    }
    if (d.all && d.all.sources && typeof d.all.sources === "object") {   // 其余启用源的摘要（tooltip 分家列全）
      var others = [];
      for (var sid in d.all.sources) {
        if (!Object.prototype.hasOwnProperty.call(d.all.sources, sid) || sid === d.all.active) continue;
        var sv = d.all.sources[sid];
        if (!sv || sv.status !== "ok") continue;
        var sum = sv.balance && typeof sv.balance.amount === "number" ? quotaBalanceText(sv.balance)
          : (sv.windows ? ["plan", "fiveHour", "weekly", "monthly"].map(function (k) {
              return sv.windows[k] && typeof sv.windows[k].percent === "number"
                ? Math.round(rem ? quotaRemainPct(sv.windows[k].percent) : sv.windows[k].percent) + "%" : null;
            }).filter(Boolean).join(" ") : "✓");
        others.push(esc(d.srcLabels && d.srcLabels[sid] || sid) + " " + sum);
      }
      if (others.length) out += row(L("其他源", "Other sources"), others.join(" · "));
    }
    if (q.tools && (q.tools.total != null || q.tools.used != null)) {
      var tr = qTime(q.tools.resetsAt);
      out += row(L("内置工具", "Built-in tools"), (q.tools.used == null ? "—" : q.tools.used) + " / " + (q.tools.total == null ? "—" : q.tools.total) +
        L(" 次", " calls") + (tr ? " · " + L("重置 ", "resets ") + tr : ""));
    }
    var models = Array.isArray(q.models) ? q.models : [], cur = String(d.model || "");
    var scope = models.length
      ? models.map(function (m) { return String(m).toLowerCase() === cur.toLowerCase() ? '<span class="qt-cur">' + esc(m) + "</span>" : esc(m); }).join(", ")
      : L("套餐内全部模型", "all models in the plan") + (cur ? L("（当前 ", " (current ") + '<span class="qt-cur">' + esc(cur) + "</span>" + L("）", ")") : "");
    if (isBalance) out += row(L("当前模型", "Current model"), esc(cur || "—"));
    else out += row(L("覆盖范围", "Covers"), scope);
      var foot = q.busy ? L("查询中…", "Querying…") : (q.fetchedAt ? L("更新于 ", "updated ") + qTime(q.fetchedAt) : "");
      foot += q.stale ? L("（已过期，等待刷新）", " (stale, refreshing)") : "";
    var err = q.status && q.status !== "ok" && q.status !== "idle" ? quotaStatusText(q.status) : "";
    if (err) foot += (foot ? " · " : "") + '<span class="qt-warn">⚠ ' + err + "</span>";
    out += '<div class="qt-note">' + (foot ? foot + "<br>" : "") +
      (isBalance
        ? L("余额属于当前供应商账号或 API Key，不是单模型独享。点击 chip 立即刷新。", "Balance belongs to the provider account or API key, not one model. Click the chip to refresh.")
        : L("套餐池为账号级：同账号所有模型共用，不是单个模型独享。点击 chip 立即刷新。", "The pool is account-level: shared by every model on this account, not per model. Click the chip to refresh.")) + "</div>";
    return out;
  }
  function showQuotaTip(el) {
    if (stale() || !el || !el.isConnected || !el.__zuQ) { hideQuotaTip(); return; }
    /* 内容签名幂等（同 gitTip，overlay-ui.md §4）：泵推送/600ms 对账会反复走到这里，
     * 无条件重写 innerHTML 会打断 tooltip 内的文本选择与滚动。 */
    var html = quotaTipHTML(el.__zuQ);
    if (quotaTip.__zuTipSig !== html) {
      quotaTip.innerHTML = html;
      quotaTip.__zuTipSig = html;
    }
    quotaTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = quotaTip.offsetWidth, th = quotaTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;               // 优先弹在 chip 上方
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    quotaTip.style.left = Math.round(left) + "px";
    quotaTip.style.top = Math.round(top) + "px";
    quotaTipFor = el;
  }
  function hideQuotaTip() {
    quotaTip.style.display = "none";
    quotaTipFor = null;
  }
  function onQuotaEnter() { showQuotaTip(this); }
  /* ---------- v135 重置卡徽标 tooltip：每账号分组的逐卡明细 ----------
   * 复用 quotaTip 的浮层模式（同 .tip 样式/上方弹出/签名幂等）；滚动豁免与伪 leave
   * 甄别与 quotaTip 同链。内容只读 el.__zuR（syncResetBadge 写入的徽标视图）。 */
  var rstTip = document.createElement("div");
  rstTip.className = "tip zusage-quota-tip";
  rstTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(rstTip);
  /* 「如何重置」按钮：监听挂 rstTip 本体（innerHTML 签名重建不丢）；外链走客户端
   * openExternal 桥（系统默认浏览器），无桥环境 window.open 兜底（同 ⚙ 取 Key 链接）。 */
  var RST_HOWTO_URL = "https://bigmodel.cn/coding-plan/personal/usage";
  rstTip.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest && e.target.closest(".rst-howto");
    if (!btn) return;
    e.stopPropagation();
    var zc = window.zcode;
    if (zc && typeof zc.openExternal === "function") zc.openExternal(RST_HOWTO_URL);
    else window.open(RST_HOWTO_URL, "_blank", "noopener");
  });
  /* 徽标↔tooltip 悬停桥：徽标与 tooltip 之间有 8px 间隙，直接 mouseleave 即收会让指针
   * 移向 tooltip（点「如何重置」）途中浮层消失。离开任一侧延迟收起，进入另一侧取消。 */
  var RST_HIDE_DELAY_MS = 180;
  var rstHideTimer = 0;
  function scheduleRstHide() {
    if (rstHideTimer) return;
    rstHideTimer = setTimeout(function () { rstHideTimer = 0; hideRstTip(); }, RST_HIDE_DELAY_MS);
  }
  function cancelRstHide() {
    if (rstHideTimer) { clearTimeout(rstHideTimer); rstHideTimer = 0; }
  }
  rstTip.addEventListener("mouseenter", cancelRstHide);
  rstTip.addEventListener("mouseleave", scheduleRstHide);
  var rstTipFor = null;
  /* ---------- v146 精简模式速率 chip tooltip：速度读数 + 状态条摘要 + 设置入口 ----------
   * 浮层模式与 quotaTip/rstTip 同款（body 级、上方弹出、签名幂等、悬停桥延迟收起）。
   * 内容由 chip 上的实例闭包 el.__zuT.buildTip(el.__zuT) 生成——摘要行需要实例作用域的
   * fmt/subRate/state.show，不能提到模块层；「打开设置」与子代理明细经 chip 上挂的
   * __zuOpen/__zuOpenSub 回调回到所属实例（多实例各回各的面板）。 */
  var tpsTip = document.createElement("div");
  tpsTip.className = "tip zusage-quota-tip zusage-tps-tip";
  tpsTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(tpsTip);
  /* v263：Tab 切换共用（全量 tip 的 speedTabActivate 同款问题——生成中浮层每 tick
   * 重编会替换按钮 DOM，click 落到共同祖先），提前到 pointerdown 同步生效。 */
  function tpsTabActivate(e) {
    var el = tpsTipFor;   // hideTpsTip 会清 tpsTipFor，回调目标先取
    if (!el) return;
    var fb = e.target && e.target.closest && e.target.closest(".zu-sv-focus");
    var t0 = el.__zuT;
    if (fb && t0 && t0.speedSel) {
      e.stopPropagation();
      t0.speedSel.focus = t0.speedSel.focus === "full" ? "" : "full";
      t.speedHover = 0;
      tpsTip.__zuTipSig = "";
      showTpsTip(el);
      return;
    }
    var tab = e.target && e.target.closest && e.target.closest(".zu-sv-tab");
    var t = el.__zuT;
    if (tab && t && t.speedSel) {
      var grp = tab.getAttribute("data-sv-group"), val = tab.getAttribute("data-sv-val");
      if ((grp === "range" && SPD_RANGES.indexOf(val) >= 0) ||
          (grp === "period" && SPD_PERIODS.indexOf(val) >= 0)) {
        e.stopPropagation();
        t.speedSel[grp] = val;
        t.speedHover = -1;
        /* v272：维度切换移除，dim 恒 time */
        tpsTip.__zuTipSig = "";
        showTpsTip(el);
      }
    }
  }
  tpsTip.addEventListener("pointerdown", tpsTabActivate);
  tpsTip.addEventListener("click", function (e) {
    var el = tpsTipFor;   // hideTpsTip 会清 tpsTipFor，回调目标先取
    if (!el) return;
    if (e.target && e.target.closest && e.target.closest(".tps-cfg")) {
      e.stopPropagation();
      hideTpsTip();
      if (el.__zuOpen) el.__zuOpen();
      return;
    }
    if (e.target && e.target.closest && e.target.closest(".tps-subrow")) {
      e.stopPropagation();
      hideTpsTip();
      if (el.__zuOpenSub) el.__zuOpenSub();
      return;
    }
    /* v255：V2 双 Tab 走 tpsTip 本体委托（全量 tip 的同款逻辑），只改 chip 数据包，
     * 由 showTpsTip 签名幂等重编；不新增全局监听、不重建浮层。
     * v263：鼠标路径提前到 pointerdown（见 tpsTabActivate），此处保留键盘与兜底。 */
    tpsTabActivate(e);
  });
  /* 柱 hover/键盘焦点：委托重建整卡，信息卡随串自愈，不额外挂逐柱监听。 */
  function tpsSpeedPick(idx) {
    var t = tpsTipFor && tpsTipFor.__zuT;
    if (!t || t.speedHover === idx) return;
    t.speedHover = idx;
    tpsTip.__zuTipSig = "";
    showTpsTip(tpsTipFor);
  }
  tpsTip.addEventListener("mouseover", function (e) {
    var col = e.target && e.target.closest && e.target.closest(".zu-sc-col");
    if (col) tpsSpeedPick(parseInt(col.getAttribute("data-i"), 10) || 0);
  });
  tpsTip.addEventListener("mouseout", function (e) {
    var col = e.target && e.target.closest && e.target.closest(".zu-sc-col");
    if (!col) return;
    var to = e.relatedTarget;
    if (to && to.closest && to.closest(".zu-sc-col")) return;
    tpsSpeedPick(-1);
  });
  tpsTip.addEventListener("focusin", function (e) {
    var col = e.target && e.target.closest && e.target.closest(".zu-sc-col");
    if (col) tpsSpeedPick(parseInt(col.getAttribute("data-i"), 10) || 0);
  });
  tpsTip.addEventListener("focusout", function (e) {
    var col = e.target && e.target.closest && e.target.closest(".zu-sc-col");
    if (col && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".zu-sc-col"))) tpsSpeedPick(-1);
  });
  var TPS_HIDE_DELAY_MS = 180, tpsHideTimer = 0;
  function scheduleTpsHide() {
    if (tpsHideTimer) return;
    tpsHideTimer = setTimeout(function () { tpsHideTimer = 0; hideTpsTip(); }, TPS_HIDE_DELAY_MS);
  }
  function cancelTpsHide() {
    if (tpsHideTimer) { clearTimeout(tpsHideTimer); tpsHideTimer = 0; }
  }
  tpsTip.addEventListener("mouseenter", cancelTpsHide);
  tpsTip.addEventListener("mouseleave", scheduleTpsHide);
  var tpsTipFor = null;
  function showTpsTip(el) {
    if (stale() || !el || !el.isConnected || !el.__zuT) { hideTpsTip(); return; }
    var html = el.__zuT.buildTip(el.__zuT);
    /* v155：内容含秒表（0.1s 步进），悬停中若随心跳整片重建，「打开设置」/子代理行的
     * 点击会落在被替换掉的旧节点上丢失——显示中内容变化时冻结当前内容、只更新位置，
     * 鼠标移开后下一次悬停按新签名重建（与 gitTip 的「滚动中不重建」同一取舍方向）。
     * v255 曾对 V2 整卡放行以让 Tab/柱 hover 即时重绘——但生成中签名每 tick 变化、
     * 悬停中每 tick 整片重建同样把 mousedown 命中的 Tab 换掉（全量 tip 的 v263 同型
     * 根因）。v263 改回统一冻结：交互路径（Tab/维度/柱 hover）本就先清 __zuTipSig
     * 再进来，清空即放行重编；心跳路径悬停中冻结，与全量 tip 的 mouseInBar 冻结同取舍。 */
    var frozen = tpsTip.__zuTipSig !== html && tpsTip.__zuTipSig && tpsTip.style.display === "block";
    if (!frozen && tpsTip.__zuTipSig !== html) {   // 签名幂等（同 quotaTip）：内容没变不重建
      tpsTip.innerHTML = html;
      tpsTip.__zuTipSig = html;
    }
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    tpsTip.classList.toggle("zu-light", !dark);
    tpsTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = tpsTip.offsetWidth, th = tpsTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    tpsTip.style.left = Math.round(left) + "px";
    tpsTip.style.top = Math.round(top) + "px";
    tpsTipFor = el;
  }
  function hideTpsTip() {
    cancelTpsHide();
    tpsTip.style.display = "none";
    tpsTipFor = null;
  }
  /* v176：子代理行内速率 chip 的悬停 tooltip（body 级共享元素，骨架同 tpsTip；内容
   * 构建器挂 chip 的 __zuT 由所属实例闭包提供，数据各回各 pane）。纯展示无点击动作。
   * chip 是动态创建/被宿主重建的节点，悬停走 document 委托不挂逐元素监听——省掉
   * 解绑扫描，宿主重挂/换代采纳旧节点后悬停天然可用。 */
  var subTip = document.createElement("div");
  subTip.className = "tip zusage-subrate-tip";
  subTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(subTip);
  var SUB_HIDE_DELAY_MS = 180, subHideTimer = 0;
  function scheduleSubHide() {
    if (subHideTimer) return;
    subHideTimer = setTimeout(function () { subHideTimer = 0; hideSubTip(); }, SUB_HIDE_DELAY_MS);
  }
  function cancelSubHide() {
    if (subHideTimer) { clearTimeout(subHideTimer); subHideTimer = 0; }
  }
  subTip.addEventListener("mouseenter", cancelSubHide);
  subTip.addEventListener("mouseleave", scheduleSubHide);
  var subTipFor = null;
  function showSubTip(el) {
    if (stale() || !el || !el.isConnected || !el.__zuT) { hideSubTip(); return; }
    var html = el.__zuT.buildTip(el.__zuT);
    if (subTip.__zuTipSig !== html) {   // 签名幂等（同 tpsTip）：内容没变不重建
      subTip.innerHTML = html;
      subTip.__zuTipSig = html;
    }
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    subTip.classList.toggle("zu-light", !dark);
    subTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = subTip.offsetWidth, th = subTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    subTip.style.left = Math.round(left) + "px";
    subTip.style.top = Math.round(top) + "px";
    subTipFor = el;
  }
  function hideSubTip() {
    cancelSubHide();
    subTip.style.display = "none";
    subTipFor = null;
  }
  function subTipDocOver(e) {
    if (stale()) return;
    var chip = e.target && e.target.closest ? e.target.closest(".zu-subrate") : null;
    if (chip && chip.__zuT) { cancelSubHide(); showSubTip(chip); return; }
    if (subTipFor && !(e.target && subTip.contains(e.target))) scheduleSubHide();
  }
  function subTipDocOut(e) {
    if (!subTipFor) return;
    var to = e.relatedTarget;
    if (to && (subTip.contains(to) || (to.closest && to.closest(".zu-subrate") === subTipFor))) return;
    scheduleSubHide();
  }
  document.addEventListener("mouseover", subTipDocOver, true);
  document.addEventListener("mouseout", subTipDocOut, true);
  var RST_FAM_LABELS = { bigmodel: "BigModel", zai: "Z.ai" };
  /* grantType 枚举的行首展示文案（服务端原值未知语义兜底显示原文；BigModel 未公布口径，
   * GLOBAL=全局发放卡 / DIRECT=直发卡为实测推断，仅作区分展示不作计费语义宣称） */
  var RST_GRANT_LABELS = { GLOBAL: L("全局", "Global"), DIRECT: L("直发", "Direct") };
  function rstGrantText(v) { return RST_GRANT_LABELS[v] || v || ""; }
  /* 徽标三档色阈值唯一事实源：resetBadgeView 判档、tooltip 图例与到期行着色共用，避免漂移。
   * dotCls 的色值定义在 rstTipHTML 注入的 <style>（含 .zu-light 浅色组） */
  var RST_BANDS = [
    { cls: "zu-rst-crit", max: 30 * 60 * 1000, dotCls: "zu-rdot-crit",
      text: L("<30 分钟（呼吸闪烁）", "<30 min (pulsing)") },
    { cls: "zu-rst-mid", max: 3 * 3600 * 1000, dotCls: "zu-rdot-mid",
      text: L("30 分钟–3 小时", "30 min–3 h") },
    { cls: "zu-rst-calm", max: Infinity, dotCls: "zu-rdot-calm",
      text: L(">3 小时", ">3 h") },
  ];
  /* 按剩余时间判档（RST_BANDS 末档 max=Infinity 恒命中）；tooltip 到期行着色与徽标同源 */
  function rstBandClsOf(rem) {
    for (var bi = 0; bi < RST_BANDS.length; bi++) {
      if (rem <= RST_BANDS[bi].max) return RST_BANDS[bi].cls;
    }
    return RST_BANDS[RST_BANDS.length - 1].cls;
  }
  function rstTipHTML(v) {
    var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
    /* rst-row 独立类名：rstTip 与 quotaTip 共用 zusage-quota-tip 类，<style> 是全局作用域，
     * 复用 .rt-row 会与额度 tooltip 的两列布局互相覆盖（单行布局用户规格 2026-10-28）。 */
    var out = '<style>.zusage-quota-tip .rst-row{margin:4px 0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}' +
      ".zusage-quota-tip .rst-group{margin:6px 0 2px}" +
      ".zusage-quota-tip .rst-group .rst-fam{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zusage-quota-tip .rst-row .rst-fam{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zusage-quota-tip .rst-row.rst-exp{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* 到期行按剩余时间档位着色（用户规格 2026-11-05）：色值同图例色点，>3 小时行维持默认色 */
      ".zusage-quota-tip .rst-row.zu-rst-mid{color:#f5b944}" +
      ".zusage-quota-tip .rst-row.zu-rst-crit{color:#ff6b57}" +
      ".zusage-quota-tip .rst-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px}" +
      ".zusage-quota-tip .rst-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 6px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zusage-quota-tip .rst-lg{display:inline-flex;align-items:center;gap:5px}" +
      ".zusage-quota-tip .rst-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}" +
      ".zusage-quota-tip .zu-rdot-calm{background:#3ecf8e}" +
      ".zusage-quota-tip .zu-rdot-mid{background:#f5b944}" +
      ".zusage-quota-tip .zu-rdot-crit{background:#ff6b57}" +
      ".zusage-quota-tip.zu-light .zu-rdot-calm{background:#0f9d6c}" +
      ".zusage-quota-tip.zu-light .zu-rdot-mid{background:#b6791a}" +
      ".zusage-quota-tip.zu-light .zu-rdot-crit{background:#d8482f}" +
      ".zusage-quota-tip.zu-light .rst-row.zu-rst-mid{color:#b6791a}" +
      ".zusage-quota-tip.zu-light .rst-row.zu-rst-crit{color:#d8482f}" +
      '.zusage-quota-tip .rst-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent));color:var(--color-tooltip-tag-foreground,#a6a6a6);overflow-wrap:anywhere}' +
      ".zusage-quota-tip .rst-howto{margin-left:6px;background:none;border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:999px;color:inherit;font:inherit;font-size:.85em;line-height:1.5;padding:0 9px;cursor:pointer}" +
      ".zusage-quota-tip .rst-howto:hover{color:var(--color-tooltip-foreground,#fafafa);border-color:var(--color-border-hover,rgba(255,255,255,.24))}</style>" +
      '<div class="rst-h">' + L("额度重置卡", "Quota reset cards") + "</div>";
    for (var i = 0; i < v.fams.length; i++) {
      var e = v.fams[i].entry;
      var label = RST_FAM_LABELS[v.fams[i].fam] || v.fams[i].fam;
      var now = Date.now();
      /* 账号名只作组头出现一次，卡片行不再重复前缀（用户规格 2026-10-28） */
      out += '<div class="rst-group"><span class="rst-fam">' + esc(label) + "</span></div>";
      /* 行首展示 grantType（用户规格 2026-10-28）：列表端点每卡自带，status 端点没有——
       * 有列表数据（bigmodel 族 resetList 开启）时整组行改由列表渲染，否则回退 status 行（无前缀） */
      var listData = e.list && typeof e.list === "object" &&
        (Array.isArray(e.list.fiveHour) || Array.isArray(e.list.week)) ? e.list : null;
      if (listData) {
        var rows = [];
        [["fiveHour", L("5小时卡", "5-hour card")], ["week", L("周卡", "Weekly card")]].forEach(function (group) {
          if (!Array.isArray(listData[group[0]])) return;
          listData[group[0]].forEach(function (card) {
            var t = card && card.expireAt;
            if (typeof t !== "number" || !isFinite(t) || t <= now - 7 * 86400000) return;
            rows.push({ time: t, label: group[1], expired: t <= now, grantType: card.grantType || "" });
          });
        });
        rows.sort(function (a, b) { return a.expired - b.expired || a.time - b.time; });
        if (!rows.length) out += '<div class="rst-row">' + L("暂无重置卡", "no reset cards") + "</div>";
        rows.forEach(function (card) {
          var prefix = rstGrantText(card.grantType);
          if (prefix) prefix += " ";
          /* 未过期行按剩余档位着色（<30 分红 / 30 分–3 时黄）；>3 小时档与过期行维持默认色 */
          var bandCls = card.expired ? "" : rstBandClsOf(card.time - now);
          out += '<div class="rst-row' + (card.expired ? " rst-exp" : bandCls === "zu-rst-calm" ? "" : " " + bandCls) + '">' +
            esc(prefix + card.label + " · " + (card.expired ? L("已过期 ", "Expired ") : L("到期 ", "Expires ")) + qTimeS(card.time)) + "</div>";
        });
        var lastRow = [];
        if (e.lastFiveHour) lastRow.push(L("5小时窗 ", "5-hour ") + e.lastFiveHour.slice(0, 19));
        if (e.lastWeek) lastRow.push(L("周窗 ", "weekly ") + e.lastWeek.slice(0, 19));
        if (lastRow.length) {
          out += '<div class="rst-row">' + esc(L("上次重置 ", "last reset ") + lastRow.join(L("；", "; "))) + "</div>";
        }
      } else {
      var cards = [];
      [[e.fiveHour, L("5小时卡", "5-hour card")], [e.week, L("周卡", "Weekly card")]].forEach(function (group) {
        if (!Array.isArray(group[0])) return;
        group[0].forEach(function (card) {
          var t = card && card.expireAt;
          if (typeof t !== "number" || !isFinite(t) || t <= now - 7 * 86400000) return;
          cards.push({ time: t, label: group[1], expired: t <= now });
        });
      });
      /* 旧冷主进程（resetList 之前）的字段名是 history：只有近 7 天过期卡。热文件先于冷
       * 文件部署是常态，渲染端必须兼容两种字段，否则过期行在重启前整段消失（实测）。 */
      var legacyHist = e.history && typeof e.history === "object" ? e.history : null;
      if (legacyHist) {
        var seenValid = {};
        cards.forEach(function (card) { seenValid[card.label + card.time] = 1; });
        var legacyExpired = [];
        [["fiveHour", L("5小时卡", "5-hour card")], ["week", L("周卡", "Weekly card")]].forEach(function (group) {
          if (!Array.isArray(legacyHist[group[0]])) return;
          legacyHist[group[0]].forEach(function (card) {
            var t = card && card.expireAt;
            if (typeof t !== "number" || !isFinite(t) || t > now || now - t > 7 * 86400000) return;
            if (seenValid[group[1] + t]) return;
            legacyExpired.push({ time: t, label: group[1] });
          });
        });
        legacyExpired.sort(function (a, b) { return b.time - a.time; });
        legacyExpired.forEach(function (card) {
          cards.push({ time: card.time, label: card.label, expired: true });
        });
      }
      cards.sort(function (a, b) { return a.expired - b.expired || a.time - b.time; });
      if (!cards.length) out += '<div class="rst-row">' + L("暂无重置卡", "no reset cards") + "</div>";
      cards.forEach(function (card) {
        /* 未过期行按剩余档位着色（同上 listData 路径） */
        var bandCls = card.expired ? "" : rstBandClsOf(card.time - now);
        out += '<div class="rst-row' + (card.expired ? " rst-exp" : bandCls === "zu-rst-calm" ? "" : " " + bandCls) + '">' +
          esc(card.label + " · " + (card.expired ? L("已过期 ", "Expired ") : L("到期 ", "Expires ")) + qTimeS(card.time)) + "</div>";
      });
      }
    }
    var footBusy = false, footStale = false, footAt = 0;
    for (var fi2 = 0; fi2 < v.fams.length; fi2++) {
      var fe = v.fams[fi2].entry;
      if (fe.busy) footBusy = true;
      if (fe.stale) footStale = true;
      if (fe.fetchedAt > footAt) footAt = fe.fetchedAt;
    }
    var foot = footBusy ? L("查询中…", "Querying…") : (footAt ? L("更新于 ", "updated ") + qTime(footAt) : "");
    if (footStale) foot += (foot ? " · " : "") + L("部分数据已过期，等待刷新", "some data stale, refreshing");
    /* 颜色图例：色点类与徽标三档同源（RST_BANDS），浅色主题由 rstTip 的 .zu-light 组覆盖 */
    var legend = '<div class="rst-legend">';
    for (var li = 0; li < RST_BANDS.length; li++) {
      legend += '<span class="rst-lg"><i class="rst-dot ' + RST_BANDS[li].dotCls + '"></i>' + esc(RST_BANDS[li].text) + "</span>";
    }
    legend += "</div>";
    out += '<div class="rst-note">' + legend +
      L("徽标颜色按最快到期卡的剩余时间变化；每 5 分钟查询一次，倒计时按本机时钟推算。", "The badge color tracks the soonest card's time left; polled every 5 minutes, countdown computed locally.") + "<br>" +
      L("重置卡核销后立即把对应额度窗口恢复到 100%；到期未用自动作废。", "Using a card restores its quota window to 100% instantly; unused cards expire.") +
      ' <button type="button" class="rst-howto">' + L("如何重置", "How to reset") + "</button></div>";
    return out;
  }
  function showRstTip(el) {
    if (stale() || !el || !el.isConnected || !el.__zuR) { hideRstTip(); return; }
    var html = rstTipHTML(el.__zuR);
    if (rstTip.__zuTipSig !== html) {
      rstTip.innerHTML = html;
      rstTip.__zuTipSig = html;
    }
    /* 图例浅色色点随宿主主题换装（每次悬停时同步；悬停中切主题属边缘态，下次悬停校正） */
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    rstTip.classList.toggle("zu-light", !dark);
    rstTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = rstTip.offsetWidth, th = rstTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    rstTip.style.left = Math.round(left) + "px";
    rstTip.style.top = Math.round(top) + "px";
    rstTipFor = el;
  }
  function hideRstTip() {
    cancelRstHide();
    rstTip.style.display = "none";
    rstTipFor = null;
  }
  /* ---------- v202 预估费用说明小气泡（费用行 ? 图标悬停）：rstTip 同款浮层/悬停桥。
   * 内容三行：价格来源（models.dev）/ 计算公式（本库口径）/ 汇率来源（快照 fx.source，
   * 无汇率标 USD 原值显示）。监听在各实例 tip 本体 mouseover/out 委托（innerHTML 重建不丢）。 */
  var FXQ_ICON = '<svg class="tip-fxq" viewBox="0 0 1024 1024" width="13" height="13" fill="currentColor" style="display:inline;vertical-align:-2px;margin-left:5px;cursor:help" aria-label="?" role="img" xmlns="http://www.w3.org/2000/svg"><path d="M480 784a48 48 0 1 1 96 0 48 48 0 0 1-96 0z m74.432-158.144a32 32 0 1 1-64 0v-62.816a32 32 0 0 1 32-32c64.96 0 117.568-60.576 117.568-125.472a117.568 117.568 0 0 0-235.104 0 32 32 0 1 1-64 0 181.568 181.568 0 0 1 363.104 0c0 89.344-64.544 171.52-149.568 186.656v33.6z"/><path d="M512 992C246.912 992 32 777.088 32 512 32 246.912 246.912 32 512 32c265.088 0 480 214.912 480 480 0 265.088-214.912 480-480 480z m0-64c229.76 0 416-186.24 416-416S741.76 96 512 96 96 282.24 96 512s186.24 416 416 416z"/></svg>';
  var fxTip = document.createElement("div");
  fxTip.className = "tip zusage-quota-tip zusage-fx-tip";
  fxTip.style.cssText = rateTip.style.cssText;
  fxTip.style.zIndex = "2147483647";   // 主 tip 2147483646 且 DOM 在后：同层会被盖（实测），压一级
  fxTip.style.maxWidth = "380px";
  document.body.appendChild(fxTip);
  var FX_HIDE_DELAY_MS = 180;
  var fxHideTimer = 0;
  function scheduleFxHide() {
    if (fxHideTimer) return;
    fxHideTimer = setTimeout(function () { fxHideTimer = 0; hideFxTip(); }, FX_HIDE_DELAY_MS);
  }
  function cancelFxHide() {
    if (fxHideTimer) { clearTimeout(fxHideTimer); fxHideTimer = 0; }
  }
  fxTip.addEventListener("mouseenter", cancelFxHide);
  fxTip.addEventListener("mouseleave", scheduleFxHide);
  /* 气泡内来源链接（下划线）点击打开浏览器：客户端 openExternal 桥，无桥 window.open 兜底 */
  fxTip.addEventListener("click", function (e) {
    var a = e.target && e.target.closest && e.target.closest(".fx-link");
    if (!a) return;
    e.stopPropagation();
    var url = a.getAttribute("data-url");
    if (!url) return;
    var zc = window.zcode;
    if (zc && typeof zc.openExternal === "function") zc.openExternal(url);
    else window.open(url, "_blank", "noopener");
  });
  function fxTipHTML(info) {
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function link(text, url) {
      return '<span class="fx-link" role="link" tabindex="0" data-url="' + esc(url) + '" style="text-decoration:underline;cursor:pointer">' + esc(text) + "</span>";
    }
    var fx = state.data && state.data.fx;
    var rate = (fx && typeof fx.rate === "number" && isFinite(fx.rate) && fx.rate > 0) ? fx.rate : 0;
    /* 牌价随汇率折 ¥ 显示（用户口径：气泡内货币一律人民币）；无有效汇率诚实降级 USD 原值 */
    function money(n) {
      return rate > 0 ? "¥" + (n * rate).toFixed(2) : "$" + (Math.round(n * 10000) / 10000);
    }
    var unitTag = rate > 0
      ? L("（¥/百万 token，按实时汇率折算）", " (¥ per million tokens, converted at the live rate)")
      : L("（USD/百万 token）", " (USD per million tokens)");
    /* v248：模型行只来自 icon 随卡携带的上下文（data-model/data-rates/data-mcount/
     * data-mscope）。旧 default 分支借快照根部 last=全局最近活跃会话的模型，悬浮会话≠它
     * 时张冠李戴（issue：hy4 会话气泡显示 GLM-5.3-FlashX），已删；无上下文=不显模型行。 */
    var model, rates;
    if (info.type === "model") { model = info.model; rates = info.rates; }
    var modelRow = "";
    if (info.type === "project") {
      /* 项目卡语境：没有单一「当前模型」——显示计价范围（N 个模型按各自模型价格分别计价） */
      modelRow = '<div class="rt-row"><b>' + esc(L("计价范围", "Pricing scope")) + '</b><span>' +
        esc(L("项目累计的全部 " + info.count + " 个模型，按各自模型价格分别计价", "all " + info.count + " models of this project, each priced at its own model prices")) + '</span></div>';
    } else if (info.type === "scope") {
      /* 多模型卡（本轮/会话累计/今日合计/子代理汇总）同项目卡口径：计价范围。
       * scope 名词由生成端按卡本地化（data-mscope），这里只拼数量与口径。 */
      modelRow = '<div class="rt-row"><b>' + esc(L("计价范围", "Pricing scope")) + '</b><span>' +
        esc(info.scope + L("的全部 " + info.count + " 个模型，按各自模型价格分别计价", ": all " + info.count + " models, each priced at its own model prices")) + '</span></div>';
    } else if (model && rates && typeof rates.input === "number") {
      modelRow = '<div class="rt-row"><b>' + esc(info.type === "model" ? L("模型", "Model") : L("当前模型", "Current model")) + '</b><span>' + esc(model) +
        '<span style="display:block;margin-top:2px">' +
        esc(L("输入 ", "in ") + money(rates.input) + L(" · 输出 ", " · out ") + money(rates.output) +
            L(" · 缓存读 ", " · cache read ") + money(rates.cache_read) + L(" · 缓存写 ", " · cache write ") + money(rates.cache_write)) +
        unitTag + "</span></span></div>";
    }
    var fxRow = (fx && fx.source)
      ? link(String(fx.source), "https://" + fx.source) + L(" 实时汇率 · ", " live rate · ") +
        "$1 = ¥" + (Math.round(rate * 10000) / 10000)
      : L("暂无汇率，费用按 USD 原值显示", "no live rate; cost shown in USD as-is");
    return '<div class="rt-h">' + esc(L("预估费用说明", "About estimated cost")) + "</div>" + modelRow +
      '<div class="rt-row"><b>' + esc(L("价格来源", "Prices")) + '</b><span>' +
        link("models.dev", "https://models.dev/") + L(" 三方 AI 模型数据库", " third-party AI model database") + "</span></div>" +
      '<div class="rt-row"><b>' + esc(L("计算公式", "How it's computed")) + '</b><span>' +
        esc(L("按每个模型的模型价格分开算输入、缓存读写和输出（模型价格为每百万 token 的美元数；输出已含思考）",
              "each model is priced separately for input, cache read/write and output (list prices are USD per million tokens; output already includes thinking)")) + "</span></div>" +
      '<div class="rt-row"><b>' + esc(L("汇率来源", "FX source")) + '</b><span>' + fxRow + "</span></div>";
  }
  function showFxTip(el, info) {
    if (stale()) { hideFxTip(); return; }
    var html = fxTipHTML(info || { type: "default" });
    if (fxTip.__zuTipSig !== html) {   // 签名幂等：悬停中泵推送不重建（同 rstTip）
      fxTip.innerHTML = html;
      fxTip.__zuTipSig = html;
    }
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    fxTip.classList.toggle("zu-light", !dark);
    fxTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = fxTip.offsetWidth, th = fxTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    fxTip.style.left = Math.round(left) + "px";
    fxTip.style.top = Math.round(top) + "px";
  }
  function hideFxTip() {
    cancelFxHide();
    fxTip.style.display = "none";
  }
  /* 余额文本（文档级：tooltip 与实例 chip 共用）。CNY→¥、USD→$，其它带代码前缀。
   * currency 是远程响应字符串且本函数输出直接进 innerHTML（chip 与 tooltip 双 sink），
   * 在函数内统一转义（2026-10-24 审计：恶意/被黑中转可借 currency 注入）；amount 恒经
   * Number().toFixed(2) 数字化，安全。调用方不得再整体转义本函数输出（会双重转义）。
   * plain=true 供 aria-label 等纯文本场景取未转义形式（避免屏幕阅读器读出实体）。 */
  function quotaBalanceText(bal, plain) {
    var cur = String(bal.currency || "");
    if (!plain) cur = cur.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
    var sym = cur === "CNY" ? "¥" : cur === "USD" ? "$" : (cur ? cur + " " : "");
    return sym + Number(bal.amount).toFixed(2);
  }
  /* 客户端会过滤回复 HTML 的 style/class；提醒先用 Markdown 加粗，加载浮层后再着色。 */
  var noticeStyle = document.createElement("style");
  noticeStyle.textContent = '[data-zusage-notice="' + MY_GEN + '"], [data-zusage-notice="' + MY_GEN + '"] * {' +
    "color:#ef4444!important;font-weight:700!important}";
  document.body.appendChild(noticeStyle);
  var noticeNodes = [];
  function isPluginNotice(el) {
    var parent = el.parentElement;
    return document.body.contains(el) && parent && /^(P|BLOCKQUOTE)$/.test(parent.tagName) &&
      (el.textContent || "").trim().indexOf("🔴 zcode-token-usage-statusbar 插件提醒：") === 0 &&
      (parent.textContent || "").trim() === (el.textContent || "").trim() &&
      el.closest('blockquote') && el.closest('[class~="group/assistant-row"]') &&
      !el.closest('pre, code, [data-v4-user-input-bubble], [data-markdown-preview], .zusage-root, .zusage-rate-tip');
  }
  function clearNotice(el) {
    if (el.dataset.zusageNotice === String(MY_GEN)) delete el.dataset.zusageNotice;
  }
  function scanPluginNotices() {
    noticeNodes = noticeNodes.filter(function (el) {
      if (isPluginNotice(el)) return true;
      clearNotice(el);
      return false;
    });
    document.querySelectorAll("blockquote strong").forEach(function (el) {
      if (el.dataset.zusageNotice === String(MY_GEN) || !isPluginNotice(el)) return;
      el.dataset.zusageNotice = String(MY_GEN);
      noticeNodes.push(el);
    });
  }
  var rateBindings = [];
  function isRateLine(el) {
    var t = el.textContent || "";
    /* 「tok/s(本轮)」是 v85 前的旧标记：模型时代贴进历史的行与升级前已缓存的富文本仍带它 */
    return document.body.contains(el) && (t.indexOf("token/s(本轮)") >= 0 || t.indexOf("tok/s(本轮)") >= 0) && t.indexOf("⚡") >= 0 &&
      !(el.tagName === "BLOCKQUOTE" && el.querySelector("p"));
  }
  function unbindRateLine(binding) {
    var el = binding.el;
    el.removeEventListener("mouseenter", onRateEnter);
    el.removeEventListener("mouseleave", hideRateTip);
    if (el.dataset.zusageRateTip === String(MY_GEN)) delete el.dataset.zusageRateTip;
    if (el.style.cursor === "help") el.style.cursor = binding.cursor;
  }
  function onRateEnter() { showRateTip(this); }
  function scanRateLines() {
    if (stale()) { cleanupRateTip(); return; }
    /* chip 随宿主重建被替换时浏览器不发 mouseleave，tooltip 会悬挂；豁免滚动收起（v106）
     * 后此处是 detach 场景的兜底健康检查（500ms 周期，与速率行扫描共用足迹） */
    if (quotaTipFor && !quotaTipFor.isConnected) hideQuotaTip();
    if (rstTipFor && !rstTipFor.isConnected) hideRstTip();   // v135：徽标随宿主重建 detach 的兜底收起
    if (tpsTipFor && !tpsTipFor.isConnected) hideTpsTip();   // v146：速率 chip 随宿主重建 detach 的兜底收起
    if (subTipFor && !subTipFor.isConnected) hideSubTip();   // v176：行内速率 chip 随宿主重建 detach 的兜底收起
    scanPluginNotices();
    rateBindings = rateBindings.filter(function (binding) {
      if (state.rateLine && isRateLine(binding.el)) return true;
      unbindRateLine(binding);
      return false;
    });
    if (!state.rateLine) { hideRateTip(); return; }
    var nodes = document.querySelectorAll("blockquote p, blockquote, p");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.dataset.zusageRateTip === String(MY_GEN) || !isRateLine(el)) continue;
      rateBindings.push({ el: el, cursor: el.style.cursor });
      el.dataset.zusageRateTip = String(MY_GEN);
      el.style.cursor = "help";
      el.addEventListener("mouseenter", onRateEnter);
      el.addEventListener("mouseleave", hideRateTip);
    }
    if (rateTipFor && !isRateLine(rateTipFor)) hideRateTip();
  }
  function cleanupRateTip() {
    clearInterval(rateScanTimer);
    rateBindings.forEach(unbindRateLine);
    rateBindings = [];
    noticeNodes.forEach(clearNotice);
    noticeNodes = [];
    noticeStyle.remove();
    hideRateTip();
    rateTip.remove();
    hideQuotaTip();
    quotaTip.remove();
    hideRstTip();
    rstTip.remove();
    hideTpsTip();
    tpsTip.remove();   // v146：精简模式速率 tooltip 同链清理
    hideFxTip();
    fxTip.remove();   // v202：预估费用说明小气泡同链清理
    window.removeEventListener("scroll", hideTipsOnScroll, true);
    if (window.__zusageRateCleanup === cleanupRateTip) delete window.__zusageRateCleanup;
  }
  /* 捕获：任意容器滚动即收——仅速率行浮层需要（宿主在消息流正文内，滚动即移位，fixed 浮层
   * 不跟随即指向错误位置）。额度 chip 与 git chip 同款固定在 composer 工具行，消息流滚动
   * 不移动它，豁免（v106）：思考中流式输出驱动聊天容器持续自动滚动，若一并收起则 tooltip
   * 悬停弹出即灭。quotaTip 由 mouseleave/blur/代际清理/开关关闭收起；chip 随宿主重建被
   * 替换（无 mouseleave）由 scanRateLines 的 isConnected 健康检查兜底。 */
  function hideTipsOnScroll() { hideRateTip(); }
  window.addEventListener("scroll", hideTipsOnScroll, true);
  /* v88：扫描与心跳统一 0.5s（用户要求计时 0.5s 步进；富文本重试上限同步放大保持 ~12s 等库窗口） */
  var rateScanTimer = setInterval(scanRateLines, 500);
  window.__zusageRateCleanup = cleanupRateTip;
  scanRateLines();

  /* ---------- Git chip 的悬停说明（v96）：document 级单例，同 rateTip 套路（挂 body、内联兜底样式） ----------
   * 内容按 chip.__zuGit（{path, st, stale}）渲染；分支名/上游/路径是用户数据，一律过 gitEsc。 */
  var gitTip = document.createElement("div");
  gitTip.className = "tip zusage-git-tip";
  gitTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(gitTip);
  var gitTipFor = null;
  function gitEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function gitTimeStr(ts) {   // yyyy-MM-dd HH:mm:ss（与额度 chip 的 tooltip 时间格式约定一致，用户要求带秒）
    try {
      var t = new Date(ts), p = function (n) { return ("0" + n).slice(-2); };
      return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate()) + " " + p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds());
    } catch (e) { return ""; }
  }
  /* 进行中 Git 操作的展示名（主进程 fs 探针 detectGitOp 的代码 → 双语标签；am 主栏短标签「补丁」） */
  var GIT_OP_LABELS = { rebase: ["变基", "rebase"], merge: ["合并", "merge"], "cherry-pick": ["拣选", "cherry-pick"], revert: ["还原", "revert"], bisect: ["二分", "bisect"], am: ["补丁", "patch"] };
  function gitOpLabel(code) { var m = GIT_OP_LABELS[code]; return m ? L(m[0], m[1]) : code; }
  /* v96 multi：多仓库聚合口径（chip/aria/tooltip 共用）——总数、脏仓数（成功仓 changed>0 或
   * untracked>0）、改动/未跟踪文件求和、失败仓数、任一成功仓有冲突；聚合数由渲染端算，主进程不提供。 */
  function gitMultiAgg(st) {
    var repos = st && Array.isArray(st.repos) ? st.repos : [];
    /* known=已确认仓库（成功或携带旧快照的失败仓）；changed/conflict/op 只在确认数据上统计；
     * 旧缓存（stale）里的冲突不汇总为已确认冲突，但其改动计入已知改动。 */
    var agg = { total: repos.length, known: 0, changed: 0, conflict: 0, op: 0, failed: 0, staleAny: false, m: 0, q: 0 };
    for (var i = 0; i < repos.length; i++) {
      var r = repos[i];
      if (r.err) {
        agg.failed++;
        if (r.stale) {
          agg.known++; agg.staleAny = true;
          if ((r.changed | 0) > 0 || (r.untracked | 0) > 0) agg.changed++;
        }
        continue;
      }
      agg.known++;
      if (r.stale) agg.staleAny = true;
      if ((r.changed | 0) > 0 || (r.untracked | 0) > 0) agg.changed++;
      if ((r.conflicts | 0) > 0 && !r.stale) agg.conflict++;
      if (r.op && !r.stale) agg.op++;
      agg.m += r.changed | 0;
      agg.q += r.untracked | 0;
    }
    return agg;
  }
  /* v133 Git 计数缩写（用户规格 2026-10-28）：<1万原值；≥1万 中文（cnUnits 判定）万/亿、
   * 英文 k/M/B——k 门槛刻意抬到 1万（9999 内原值），与 token fmt() 的 K≥1000 不同；小写 k、
   * 至多两位小数去尾零、数字与单位紧邻。仓库个数与 aria 播报（gitChipAria）不缩写。 */
  function unit2(x) { return x.toFixed(2).replace(/\.?0+$/, ""); }   // 与实例内 cnUnit 同规则：fmt..sec 源码切片被测试整段求值，不能跨作用域共用
  function gitNum(n) {
    n = n | 0;
    if (n < 1e4) return String(n);
    if (cnUnits()) return n >= 1e8 ? unit2(n / 1e8) + "亿" : unit2(n / 1e4) + "万";
    if (n >= 1e9) return unit2(n / 1e9) + "B";
    if (n >= 1e6) return unit2(n / 1e6) + "M";
    return unit2(n / 1e3) + "k";
  }
  /* tooltip 行样式单/多仓共用：rt-row 补 min-width:0 允许 flex 行收缩防长仓库名溢出；
   * zu-gname=多仓行仓库名（可收缩断行，main 前景色 600 字重），zu-gconf=冲突红，
   * c-mod/c-unt=已跟踪变更/未跟踪（黄），c-warn=失败/过期/未知（黄），c-op=操作名（中性），
   * zu-git-rows=多仓逐仓列表滚动容器；data-zusage-light 切浅色语义档（showGitTip 随 chip 同步）。 */
  var GIT_TIP_CSS = '<style>.zusage-git-tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#e6e6e6);margin:0 0 7px}' +
    ".zusage-git-tip .rt-row{display:flex;gap:10px;margin:3px 0;min-width:0}" +
    ".zusage-git-tip .rt-row b{flex:0 0 auto;min-width:78px;color:var(--color-tooltip-foreground,#e6e6e6);font-weight:600}" +
    ".zusage-git-tip .rt-row span{color:var(--color-tooltip-tag-foreground,#a6a6a6);word-break:break-all}" +
    ".zusage-git-tip b.zu-gname{flex:0 1 auto;min-width:0;word-break:break-all;font-weight:600}" +
    ".zusage-git-tip .zu-gbr{color:var(--color-tooltip-tag-foreground,#afafb2)}" +
    ".zusage-git-tip .c-mod,.zusage-git-tip .c-unt,.zusage-git-tip .c-warn{color:#f0e6a0}" +
    ".zusage-git-tip .zu-gconf{color:#f09696}" +
    ".zusage-git-tip .c-op{color:var(--color-tooltip-tag-foreground,#afafb2)}" +
    ".zusage-git-tip .zu-gsep{opacity:.6}" +
    ".zusage-git-tip .zu-gdiv{color:var(--color-tooltip-tag-foreground,#afafb2);opacity:.85}" +
    ".zusage-git-tip .zu-git-rows{max-height:60vh;overflow-y:auto;overscroll-behavior:contain}" +
    ".zusage-git-tip[data-zusage-light] .rt-h,.zusage-git-tip[data-zusage-light] .rt-row b,.zusage-git-tip[data-zusage-light] b.zu-gname{color:var(--color-tooltip-foreground,#2e3440)}" +
    ".zusage-git-tip[data-zusage-light] .c-mod,.zusage-git-tip[data-zusage-light] .c-unt,.zusage-git-tip[data-zusage-light] .c-warn{color:#946200}" +
    ".zusage-git-tip[data-zusage-light] .zu-gconf{color:#d20f39}" +
    '.zusage-git-tip .rt-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-border,transparent);color:var(--color-tooltip-tag-foreground,#afafb2)}</style>';
  function gitTipHTML(view) {
    if (view.st.kind === "multi") return gitMultiTipHTML(view);
    var st = view.st, row = function (label, text) { return '<div class="rt-row"><b>' + label + "</b><span>" + text + "</span></div>"; };
    var items = function (n) { return gitNum(n) + L(" 项", n === 1 ? " entry" : " entries"); };   // porcelain 条目：重命名计 1、未跟踪目录折叠计 1，不冒充文件数
    var up = st.upstream ? gitEsc(st.upstream) + (st.ahead > 0 ? " ↑" + gitNum(st.ahead) : "") + (st.behind > 0 ? " ↓" + gitNum(st.behind) : "") : L("未设置上游分支（↑↓ 不可用）", "no upstream set (ahead/behind unavailable)");
    var when = gitTimeStr(st.ts);
    return GIT_TIP_CSS +
      '<div class="rt-h">⎇ ' + L("Git 状态", "Git status") + (view.stale ? ' <span class="c-warn">' + L("· 上次查询失败，显示的是最近成功结果", "· last query failed; showing the last good result") + "</span>" : "") + "</div>" +
      row(L("分支", "Branch"), st.detached ? L("游离 HEAD（不在任何分支上）", "detached HEAD (on no branch)") : gitEsc(st.branch || "") + (st.noCommits ? L("（尚无首次提交）", " (no initial commit yet)") : "")) +
      row(L("上游", "Upstream"), up) +
      row(L("已暂存", "Staged"), items(st.staged)) +
      row(L("未暂存", "Unstaged"), items(st.unstaged)) +
      row(L("未跟踪", "Untracked"), items(st.untracked) + L("（目录折叠计 1）", " (collapsed dirs count as 1)")) +
      (st.conflicts > 0 ? row(L("冲突", "Conflicts"), '<span class="zu-gconf">!' + items(st.conflicts) + "</span>") : "") +
      (st.op ? row(L("进行中操作", "Git operation"), gitEsc(gitOpLabel(st.op))) : "") +
      row(L("改动行数", "Diff lines"), "+" + gitNum(st.ins) + " / -" + gitNum(st.del) + L(" 行（工作区相对 HEAD 的合计口径，非净差异）", " lines (worktree vs HEAD, combined—not a net diff)")) +
      row(L("目录", "Directory"), gitEsc(st.repoPath || view.path)) +   // v96：repoPath=真实仓库绝对路径，缺省回退工作区路径
      (when ? row(L("更新于", "Updated"), when) : "") +
      '<div class="rt-note">' + L("只读本地仓库，不自动 fetch（上游比较基于本地引用）；远端会话不显示。⚙ 设置可关。",
        "Local repositories read-only, never auto-fetches (upstream compares against local refs); hidden for remote sessions. Toggle in ⚙ settings.") + "</div>";
  }
  /* v96 multi tooltip：概览（标题 / 有改动仓库与非零冲突·操作·失败 / 覆盖行）→ 逐仓全量列表
   * （优先级：冲突 0 < 失败或过期 1 < 操作中 2 < 有改动 3 < 上游差异 4 < 干净 5；同级码点序，
   * 不用 localeCompare；干净组前插分隔行，所有行都在滚动容器内可访问）→ 元信息（工作目录 /
   * 更新时间 / 口径）。失败仓携带的旧快照标「过期」，其冲突不汇总为已确认。仓库名/分支/路径
   * 是用户数据，一律过 gitEsc/属性转义。 */
  function gitMultiTipHTML(view) {
    var st = view.st, agg = gitMultiAgg(st);
    var row = function (label, text) { return '<div class="rt-row"><b>' + label + "</b><span>" + text + "</span></div>"; };
    var attr = function (s) { return gitEsc(s).replace(/"/g, "&quot;"); };   // title 属性需转义引号
    var rrow = function (name, text, title) { return '<div class="rt-row"><b class="zu-gname"' + (title ? ' title="' + title + '"' : "") + ">" + name + '</b><span>' + text + "</span></div>"; };
    var rank = function (r) {
      if (r.err || r.stale) return 1;
      if ((r.conflicts | 0) > 0) return 0;
      if (r.op) return 2;
      if ((r.changed | 0) > 0 || (r.untracked | 0) > 0) return 3;
      if ((r.ahead | 0) > 0 || (r.behind | 0) > 0) return 4;
      return 5;
    };
    var repos = (st.repos || []).slice();   // 排序不动主进程推送的原数组；与 gitMultiAgg 同款防御
    repos.sort(function (a, b) { var ra = rank(a), rb = rank(b); return ra !== rb ? ra - rb : a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    var h = GIT_TIP_CSS + '<div class="rt-h">⎇ ' + L("Git 状态", "Git status") + L(" · " + agg.total + " 个仓库", " · " + agg.total + " repos") + "</div>";
    var ov = L("有改动 <b class=\"c-mod\">" + agg.changed + "</b> 个仓库", "<b class=\"c-mod\">" + agg.changed + "</b> repos with changes");
    if (agg.conflict > 0) ov += '<span class="zu-gsep"> · </span><span><b class="zu-gconf">!' + agg.conflict + '</b>' + L(" 个仓库冲突", " repos conflicted") + "</span>";
    if (agg.op > 0) ov += '<span class="zu-gsep"> · </span><span><b class="c-op">' + agg.op + '</b>' + L(" 个仓库操作中", " repos mid-operation") + "</span>";
    if (agg.failed > 0) ov += '<span class="zu-gsep"> · </span><span><b class="c-warn">' + agg.failed + '</b>' + L(" 个查询失败", " failed") + "</span>";
    if (view.stale) ov += '<span class="zu-gsep"> · </span><span class="c-warn">' + L("上次查询失败，显示的是最近成功结果", "last query failed; showing the last good result") + "</span>";
    h += '<div class="rt-ov">' + ov + "</div>";
    if (agg.m > 0 || agg.q > 0) {
      var sm = [];
      if (agg.m > 0) sm.push(L("已跟踪变更 <b class=\"c-mod\">" + gitNum(agg.m) + "</b> 项", "<b class=\"c-mod\">" + gitNum(agg.m) + "</b> tracked-change entries"));
      if (agg.q > 0) sm.push(L("未跟踪 <b class=\"c-unt\">" + gitNum(agg.q) + "</b> 项", "<b class=\"c-unt\">" + gitNum(agg.q) + "</b> untracked entries"));
      h += '<div class="rt-ov">' + sm.join('<span class="zu-gsep"> · </span>') + "</div>";
    }
    if (agg.known < agg.total) h += '<div class="rt-ov"><span class="c-warn">' + L("已确认 " + agg.known + "/" + agg.total + " 个仓库", "Confirmed " + agg.known + "/" + agg.total + " repos") + (agg.failed ? " · " + L(agg.failed + " 个查询失败", agg.failed + " failed") : "") + "</span></div>";
    var cleanTotal = 0, focused = 0, divDone = false, rows = "";
    for (var i = 0; i < repos.length; i++) { if (rank(repos[i]) === 5) cleanTotal++; else focused++; }
    for (var j = 0; j < repos.length; j++) {
      var r = repos[j], rk = rank(r);
      if (rk === 5 && focused > 0 && cleanTotal > 0 && !divDone) {   // 干净组分隔行（其余仓仍全部可访问）
        rows += '<div class="rt-row zu-gdiv"><span>' + L("其余 " + cleanTotal + " 个仓库，无本地改动", cleanTotal + " more repos with no local changes") + "</span></div>";
        divDone = true;
      }
      if (r.err) {
        var msg = { notrepo: L("非 Git 仓库", "not a git repository"), nogit: L("未找到 git", "git not found"), timeout: L("超时", "timed out"), error: L("出错", "error") }[r.err] || r.err;
        var t = '<span class="c-warn">⚠ ' + L("查询失败", "query failed") + "（" + gitEsc(msg) + "）</span>";
        if (r.stale) {   // 携带旧快照：标注历史属性并展示上次分支与改动（旧冲突不作已确认，不在此渲染）
          t += ' <span class="c-warn">' + L("过期；以下为上次结果", "stale; showing last good result") + "</span>";
          if (r.branch) t += ' <span class="zu-gbr">' + gitEsc(r.branch) + "</span>";
          if ((r.changed | 0) > 0) t += ' <span class="c-mod">' + L("改 " + gitNum(r.changed) + " 项", gitNum(r.changed) + " mod") + "</span>";
          if ((r.untracked | 0) > 0) t += ' <span class="c-unt">' + L("新 " + gitNum(r.untracked) + " 项", gitNum(r.untracked) + " new") + "</span>";
        }
        rows += rrow(gitEsc(r.name), t, attr(r.path));
        continue;
      }
      var seg = '<span class="zu-gbr">' + (r.detached ? L("HEAD（游离）", "HEAD (detached)") : gitEsc(r.branch || (r.noCommits ? L("初始", "init") : ""))) + (r.noCommits && !r.detached ? L("（尚无首次提交）", " (no initial commit yet)") : "") + "</span>";
      if (r.op && !r.stale) seg += ' <span class="c-op">' + gitEsc(gitOpLabel(r.op)) + "</span>";
      if (r.stale) seg += ' <span class="c-warn">' + L("过期", "stale") + "</span>";
      if ((r.conflicts | 0) > 0) seg += ' <span class="zu-gconf">!' + gitNum(r.conflicts) + L(" 冲突", " conflicted") + "</span>";
      if ((r.changed | 0) > 0) seg += ' <span class="c-mod">' + L("改 " + gitNum(r.changed) + " 项", gitNum(r.changed) + " mod") + "</span>";
      if ((r.untracked | 0) > 0) seg += ' <span class="c-unt">' + L("新 " + gitNum(r.untracked) + " 项", gitNum(r.untracked) + " new") + "</span>";
      if ((r.ahead | 0) > 0) seg += " ↑" + gitNum(r.ahead);
      if ((r.behind | 0) > 0) seg += " ↓" + gitNum(r.behind);
      rows += rrow(gitEsc(r.name), seg, attr(r.path));   // title=完整路径（宿主原生提示可访问完整值）
    }
    if (st.more > 0) rows += '<div class="rt-row"><span class="zu-gmore">' + L("另有 " + st.more + " 个子仓库未统计", st.more + " more repos not scanned") + "</span></div>";
    h += '<div class="zu-git-rows">' + rows + "</div>";
    h += row(L("工作目录", "Work dir"), gitEsc(view.path) + L("，下含 " + agg.total + " 个仓库", " · " + agg.total + " repos"));
    var when = gitTimeStr(st.ts);
    h += when ? row(L("更新于", "Updated"), when + L(" · 每 10 秒及每轮回复后自动刷新，点击 chip 立即刷新", " · auto-refreshes every 10s and after each reply; click chip to refresh now")) : "";
    return h + '<div class="rt-note">' + L("口径：改=已跟踪变更条目（含增删改名与冲突文件），新=未跟踪条目（目录折叠计 1，文件与目录混合计数）。仓库列表全量展开，超出屏幕可滚动。",
      "Units: mod = tracked-change entries (add/delete/rename/conflict), new = untracked entries (collapsed dirs count as 1). The repo list is fully expanded and scrolls when taller than the screen.") + "</div>";
  }
  function showGitTip(chip) {
    var view = chip && chip.__zuGit;
    if (stale() || !view || !chip.isConnected) { hideGitTip(); return; }
    /* 内容签名不变就跳过重建：enhanceGitChip 每 600ms 对账、每次推送都会走到这里，
     * 无条件重写 innerHTML 会打断滚动条拖拽并与滚轮滚动互抢（卡顿根因）；数据本身
     * 10 秒才变一次， hover 期间几乎总是跳过。浅色档与位置每帧照常同步。 */
    var html = gitTipHTML(view);
    if (gitTip.__zuTipSig !== html) {
      var keep = 0;   // 重建时保持列表滚动位置（不重置阅读位置）
      if (gitTipFor === chip) { try { var prevRows = gitTip.querySelector(".zu-git-rows"); if (prevRows) keep = prevRows.scrollTop; } catch (e) { } }
      gitTip.innerHTML = html;
      gitTip.__zuTipSig = html;
      try { var rowsEl = gitTip.querySelector(".zu-git-rows"); if (rowsEl && keep) rowsEl.scrollTop = keep; } catch (e) { }
    }
    if (chip.getAttribute("data-zusage-light") === "1") gitTip.setAttribute("data-zusage-light", "1");   // 语义色浅色档随 chip 主题（与内容无关，每次同步）
    else gitTip.removeAttribute("data-zusage-light");
    gitTip.style.display = "block";
    var r = chip.getBoundingClientRect(), tw = gitTip.offsetWidth, th = gitTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;   // 优先弹在 chip 上方（工具行贴窗口底部）
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    gitTip.style.left = Math.round(left) + "px";
    gitTip.style.top = Math.round(top) + "px";
    gitTipFor = chip;
  }
  function hideGitTip() {
    clearTimeout(gitTipHideTimer);
    gitTip.style.display = "none";
    gitTipFor = null;
  }
  /* 鼠标从 chip 移入 tooltip 的宽限桥：延迟收起，移入即取消（支持移入悬浮内容继续阅读）；
   * Esc 关闭后 gitTipFor 已空，普通数据刷新不会重新弹出（只有再次悬停 chip 才会）。 */
  var gitTipHideTimer = 0;
  function hideGitTipSoon() { clearTimeout(gitTipHideTimer); gitTipHideTimer = setTimeout(hideGitTip, 200); }
  function onGitTipEnter() { clearTimeout(gitTipHideTimer); }
  function onGitKeydown(e) { if (e && e.key === "Escape") hideGitTip(); }
  function onRefreshKeydown(e) {
    if (e.key === "Enter") { e.preventDefault(); this.click(); }
    else if (e.key === " ") e.preventDefault();
  }
  function onRefreshKeyup(e) { if (e.key === " ") { e.preventDefault(); this.click(); } }
  window.addEventListener("keydown", onGitKeydown, true);
  gitTip.addEventListener("mouseenter", onGitTipEnter);
  gitTip.addEventListener("mouseleave", hideGitTip);
  /* chip 固定在 composer 工具行，消息流滚动不移动它，无需 rateTip 那样的 scroll 收起；离开/失焦即收 */
  function cleanupGitTip() {
    window.removeEventListener("keydown", onGitKeydown, true);
    clearTimeout(gitTipHideTimer);
    hideGitTip();
    gitTip.remove();
  }

  /* ---------- renderer 会话 store 桥（v71）：实时统计 + 确定性历史行 ----------
   * 只读桥由 renderer 侧资产注入：__zusageGetExistingConversationStore(scope) 返回
   * {getState,subscribe,off}|null；__zusageConversationDiagnostics() 枚举存活 registry
   * （sessions[].key = "<remoteSessionId> <workspace>"，topic = "conversation/<sid>"）。
   * 统计内核在 turn-stats.js（先于本文件注入，globalThis.ZUsageTurnStats）。
   * API 缺失 / 无匹配 session / 无内核：整体降级为 DB 轮询路径（悬浮条行为不变）。 */
  var TURN_STATS = null;   // 注入序保证先于本文件；缺失即禁用桥功能
  try { TURN_STATS = window.ZUsageTurnStats || globalThis.ZUsageTurnStats || null; } catch (e) { }
  function zuBridgeApi() {
    try {
      var diag = window.__zusageConversationDiagnostics, get = window.__zusageGetExistingConversationStore;
      if (typeof diag !== "function" || typeof get !== "function") return null;
      return { diag: diag, get: get };
    } catch (e) { return null; }
  }
  /* scope 的 workspace 半边从 diagnostics 的 key 解析（renderer_live_check 实测格式：
   * "<remote> <workspace>"，本地会话 remote="__base__"）。workspacePath / workspaceIdentity
   * 两种键各试一次，命中即返回 store。 */
  function zuTryBindStore(sid, want) {
    var api = zuBridgeApi();
    if (!api || !sid) return null;
    var diag = null;
    try { diag = api.diag(); } catch (e) { return null; }
    var sessions = (diag && diag.sessions) || [];
    var topic = "conversation/" + sid;
    if (want) {
      var expectedKey = "__base__ " + want.workspacePath;
      var matches = sessions.filter(function (entry) { return entry && entry.topic === topic && entry.key === expectedKey; });
      if (matches.length !== 1) return null;
    }
    for (var i = 0; i < sessions.length; i++) {
      var entry = sessions[i];
      if (!entry || entry.topic !== topic) continue;
      var key = String(entry.key || ""), sp = key.indexOf(" ");
      if (sp < 0) continue;
      var remote = key.slice(0, sp), workspace = key.slice(sp + 1);
      if (!remote || !workspace.trim()) continue;
      /* v174：带 want（实例已验证的 scope）时按 registry key 精确匹配——同 sid 跨本地/
       * 远端、多 workspace 并存时不用"首个命中"决定归属；匹配不到返回 null 走 DB 降级，
       * 绝不绑别的 pane 的 store。want 缺省保持既有行为（主分栏/子代理槽位不变）。 */
      if (want) {
        var expWs = (want.identity && String(want.identity).trim()) || want.workspacePath || "";
        var expRemote = want.remoteSessionId || "__base__";
        if (remote !== expRemote || workspace !== expWs) continue;
      }
      var scopes = remote === "__base__"
        ? [{ sessionId: sid, workspacePath: workspace }, { sessionId: sid, workspaceIdentity: workspace }]
        : [{ sessionId: sid, workspacePath: workspace, remoteSessionId: remote },
           { sessionId: sid, workspaceIdentity: workspace, remoteSessionId: remote }];
      for (var j = 0; j < scopes.length; j++) {
        try { var store = api.get(scopes[j]); if (store) return store; } catch (e) { }
      }
    }
    return null;
  }
  /* v179：子代理槽位的 acquire 降级（桥 v2 的 __zusageAcquireConversationStore）。
   * 后台运行子代理在宿主注册表没有现成 store，唯有显式 acquire（同下钻路径，
   * refcount 租约、off 时 release）。子会话继承父会话工作区——scope 取本 pane
   * 已验证的 scope；远端会话的子代理跑在远端宿主上、本地无可订阅 store，直接不试。
   * 桥还是 v1（无该访问器）时恒 null，调用方退回 2s 重试（行为同 v178）。 */
  function zuAcquireSubStore(sid, scope) {
    if (typeof sid !== "string" || sid.indexOf("sess_subagent_") !== 0) return null;
    var acquire = window.__zusageAcquireConversationStore;
    if (typeof acquire !== "function" || !scope || scope.remoteSessionId) return null;
    var out = { sessionId: sid };
    if (scope.workspacePath) out.workspacePath = scope.workspacePath;
    if (scope.identity) out.workspaceIdentity = scope.identity;
    if (!out.workspacePath && !out.workspaceIdentity) return null;
    try { return acquire(out) || null; } catch (e) { return null; }
  }
  /* 活跃 turn：快照窗口里最后一个 turnHeader（key 与 turn-stats 一致 = productTurnId 优先） */
  function zuActiveTurnId(snap) {
    var rows = snap && snap.rows && snap.rows.window;
    if (!Array.isArray(rows)) return "";
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i];
      if (r && r.kind === "turnHeader" && typeof r.turnId === "string") return r.productTurnId || r.turnId;
    }
    return "";
  }
  /* 完成态摘要：与 Python 统计行同款标记「token/s(本轮)」——可被 isRateLine 识别并复用悬停解释 */
  function zuFinalText(stats) {
    var text = TURN_STATS.format(stats, cnUnits(), !!state.forceKmb);
    return text.indexOf("token/s") >= 0 ? text.replace("token/s", "token/s(本轮)") : text + "(本轮)";
  }
  function zuUnavailableText() {
    return "⚡ " + L("本轮统计不可用", "turn stats unavailable") + "(本轮)";
  }
  function zuIsUnavailableText(t) {   // 不比对整串：行可能是另一语言下插的
    t = String(t || "");
    return t.indexOf("本轮统计不可用") >= 0 || t.indexOf("turn stats unavailable") >= 0;
  }
  /* v74：完成但零输出（如纯控制/后台轮次，无可见正文）时不编造"输出 0 token · 耗时
   * XXXs"这种无意义数字——与"记录已清"同样处理为不可用，而不是把字段值直接拼进文案。 */
  function zuHasMeaningfulOutput(stats) {
    return !!stats && typeof stats.outputTokens === "number" && stats.outputTokens > 0;
  }
  /* v73：悬浮条「生成速度」合并 chip 专用——与 zuFinalText（对话内确定性
   * 历史行用，格式不可变）分开。两态统一用 tok/s 单位，避免生成中/完成切换单位：
   * 生成中按「字符/s ÷ 每 token 字符数」估算（c2t），每 token 字符数由本会话最近一次
   * 完成的真实轮次自校准（bridge handle 级，session/store 换代即重置）；首轮尚无样本
   * 时退回 DEFAULT_CHARS_PER_TOKEN 粗略估计。完成态直接用 tracker 给出的真实 tok/s。 */
  var DEFAULT_CHARS_PER_TOKEN = 2;   // 校准前的粗略估计（中英混排粗略量级），有样本后立即被取代
  /* v127 tok/s 十档色（用户规格）：按**原始速度值**分档（含下限、不含上限），本表是
   * 阈值/类名/文案的唯一事实源，CSS 只按类给色（.zu-light 组给浅色深化值）。
   * 150 以下沿用原三档类名与用户实测过的色值（hot/warm/ok，见 .zu-light 组注释），
   * 150 起进入蓝紫系新类，≥2000 Ultra 蓝紫渐变 + ✦ 星点（CSS ::before 生成）。
   * 无效值（负数/NaN/±Infinity）返回 null，调用方回退各自的中性展示，绝不判成低速。 */
  var TPS_BANDS = [
    { lo: 2000, hi: 0,    cls: "zu-ultra",   zh: "Ultra",  en: "Ultra" },
    { lo: 1000, hi: 2000, cls: "zu-magenta", zh: "极高速", en: "Hyper" },
    { lo: 800,  hi: 1000, cls: "zu-purple",  zh: "超高速", en: "Extreme" },
    { lo: 500,  hi: 800,  cls: "zu-violet",  zh: "极速",   en: "Very fast" },
    { lo: 300,  hi: 500,  cls: "zu-azure",   zh: "高速",   en: "Rapid" },
    { lo: 200,  hi: 300,  cls: "zu-sky",     zh: "快速",   en: "Fast" },
    { lo: 150,  hi: 200,  cls: "zu-teal",    zh: "较快",   en: "Brisk" },
    { lo: 70,   hi: 150,  cls: "ok",         zh: "流畅",   en: "Smooth" },
    { lo: 40,   hi: 70,   cls: "warm",       zh: "一般",   en: "Moderate" },
    { lo: 0,    hi: 40,   cls: "hot",        zh: "低速",   en: "Slow" }
  ];
  function tpsBand(v) {
    if (typeof v !== "number" || !isFinite(v) || v < 0) return null;
    for (var i = 0; i < TPS_BANDS.length; i++) if (v >= TPS_BANDS[i].lo) return TPS_BANDS[i];
    return TPS_BANDS[TPS_BANDS.length - 1];
  }
  /* tooltip 档位行文本：名称 + 数值范围（半开区间与分档口径一致；Ultra 无上限）。
   * 显示值 toFixed(1) 会把 199.96 舍入成 "200.0" 而档位仍按原始值落 150–200——
   * 悬停看到档位行即可消解这个视觉歧义，这正是本行存在的理由。 */
  function tpsBandText(b) {
    return L(b.zh, b.en) + " · " + (b.hi ? b.lo + "–" + b.hi : "≥" + b.lo) + L(" t/s", " t/s");
  }
  /* tooltip 颜色对照图例：十档「数值↔颜色」一览（升序）。档位类与条面同源——同一组
   * CSS 规则在 tip 内直接生效，浅色主题由 tip 自身的 .zu-light 组切换；ultra 档连带
   * ✦ 与渐变。纯静态字符串无用户数据，不需转义（<40 手写成 &lt;40）。 */
  /* v215 速度统计卡公共构造（三条路径共用）：scope 标签 + 双读数 hero（主读数档位色）
   * + 档位标签 + 颜色对照网格（当前档位描边）+ 统计口径 + 底部说明。
   * v232：o.segs（speedSegsOf 规整后的分段）非空时切「左读数卡 + 右柱状图」布局，
   * 左卡由 o.leftNote 承载口径短语（v235 起由 o.status.noteText 承接,现无调用方传入,钩子保留）；无 segs（旧快照/远端旧版）整块保持 v215 原布局。 */
  function speedCardHTML(o) {
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    /* v233 估宽分级（v235 阈值随左卡 300→250px 重算；结构化 status 模板下本分级
     * 当前无生效路径——fit 类 CSS 仅 .zu-speed-left 作用域而 legacy hero 不在其内，
     * 为 o.main 无 status 组合预留）：剥掉 o.main 的 HTML 标签后按字符估宽（CJK/全角 1em、其余 0.6em，
     * 空白不计量），≤6.0em 默认单行大字（ui+22，容量 222/36≈6.2em），≤9.0em 加
     * zu-speed-fit2（缩号允换行），更长加 zu-speed-fit3（再缩号 + break-word）。分级类
     * 与 mainCls 并存，CSS 只在 .zu-speed-left 作用域生效。 */
    function mainFitCls(s) {
      var text = String(s == null ? "" : s).replace(/<[^>]*>/g, "");
      var w = 0;
      for (var i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) continue;
        w += /[\u2e80-\ua4cf\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(text[i]) ? 1 : 0.6;
      }
      return w <= 6.0 ? "" : (w <= 9.0 ? " zu-speed-fit2" : " zu-speed-fit3");
    }
    var hero = '<div class="zu-stat-kpi"><div class="zu-stat-k">' + esc(L("当前读数", "Current reading")) + '</div>' +
      '<div class="zu-speed-main' + (o.mainCls ? " " + o.mainCls : "") + mainFitCls(o.main) + '">' + o.main + (o.noUnit ? "" : ' <small>t/s</small>') + '</div>' +
      (o.bandTag ? '<div class="zu-speed-bandtag"><b class="' + (o.mainCls || "") + '" style="font-weight:600">' + esc(o.bandTag) + '</b></div>' : '') +
      '</div>';
    if (o.subLabel) {
      hero += '<div class="zu-stat-kpi"><div class="zu-stat-k">' + esc(o.subLabel) + '</div>' +
        '<div class="zu-speed-sub">' + o.sub + ' <small>t/s</small></div></div>';
    }
    /* v235 结构化左卡（o.status = zuBarSpeedView 的结构化字段）：状态/名称/数值/计时/
     * 辅助/档位六个独立节点，不再把整句状态词塞进大字号读数；数值型（估算/会话均/
     * 本轮真实）走档位色，工具/Skill/思考/子代理态保持中性 dim 语义。o.status 缺席
     * （精简 chip 摘要等旧调用方）保持 o.main 拼装路径不变。 */
    function escAttr2(s) { return esc(s).replace(/"/g, "&quot;"); }
    function speedLeftHTML(st, subLine, segs) {
      /* v239（设计图）：状态标题前恒有 lucide 线性图标——完成=圆环对勾、估算=闪电、工具=齿轮、
       * 工具组=层叠、Skill=代码、子代理=多人；思考沿用状态机注入的脑动效（iconHTML）。
       * 内联自包含（本函数在 bandHelpers 切片内运行，不得引用外层图标函数）。 */
      var icoPaths = {
        avg: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
        real: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
        estimate: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
        tool: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
        toolgroup: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
        skill: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
        subagent: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
      };
      var bcls = (st.kind === "avg" || st.kind === "real" || st.kind === "estimate") && st.band ? " " + st.band.cls : "";
      var icon = st.iconHTML || (icoPaths[st.kind]
        ? '<svg class="ico' + bcls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icoPaths[st.kind] + '</svg>' : "");
      var numeric = st.kind === "avg" || st.kind === "real" || st.kind === "estimate";
      var count = st.kind === "subagent" && st.activeCount > 1
        ? ' <span class="zu-sl-count">×' + esc(st.activeCount) + "</span>" : "";
      /* v241（设计图八态复刻）：标题行=图标+状态标题（工具=动词、工具组=「查阅·执行中」、Skill=技能名·执行中
       * 两行省略 title 全名、子代理=标题+×N、思考/生成/完成=状态词）；主读数行=计时或数值，估算前缀「估」、
       * 会话均前缀「均」为小号灰字（不并入大字）；档位胶囊仅估算/会话均两态；底部说明行取 noteText。 */
      var isTimer = st.kind === "tool" || st.kind === "toolgroup" || st.kind === "skill" || st.kind === "thinking";
      var title = st.statusText, titleFull = "";
      if (st.kind === "tool" && st.nameText) title = st.nameText;
      else if (st.kind === "toolgroup" && st.nameText) title = st.nameText + L("·执行中", "·executing");
      else if (st.kind === "skill" && st.nameText) {
        title = st.nameText + L("·执行中", "·executing");
        if (st.nameFull && st.nameFull !== st.nameText) titleFull = st.nameFull + L("·执行中", "·executing");
      } else if (st.kind === "thinking") title = st.statusText + "...";
      var inner = '<div class="zu-sl-status' + (st.kind === "skill" ? " zu-sl-status--wrap" : "") + '">' + icon +
        '<span' + (bcls ? ' class="zu-sl-title ' + bcls.trim() + '"' : ' class="zu-sl-title"') +
        (titleFull || (st.kind === "tool" && st.nameText) ? ' title="' + escAttr2(titleFull || title) + '"' : "") + '>' + esc(title) + '</span>' + count + '</div>';
      /* v242:有效速度值与非计时态同门判定(subagent 也走数值分支)——0/非有限不产空读数 */
      var sv = isTimer ? null : st.speedValue;
      var hasV = typeof sv === "number" && isFinite(sv) && sv > 0;
      if (numeric && hasV) inner += '<div class="zu-sl-k">' + esc(L("当前读数", "Current reading")) + '</div>';
      var mainBlock = "";
      if (isTimer) {
        if (st.elapsedText)
          mainBlock = '<div class="zu-sl-main"><span class="zu-sl-val">' + esc(st.elapsedText) + '</span></div>';
      } else {
        if (hasV) {
          var valCls = st.band ? " " + st.band.cls : "";
          var pre = st.kind === "subagent" ? L("估", "est") : (st.kind === "avg" ? L("均", "avg") : "");
          var txt = sv % 1 ? sv.toFixed(1) : String(sv);
          mainBlock = '<div class="zu-sl-main">' + (pre ? '<small class="zu-sl-pre">' + esc(pre) + '</small>' : "") +
            '<span class="zu-sl-val' + (st.kind === "subagent" ? " dim" : valCls) + '">' + txt +
            '</span><small class="zu-sl-unit">t/s</small></div>';
        } else if (st.kind === "subagent") {
          mainBlock = '<div class="zu-sl-main"><span class="zu-sl-estdim">' + esc(L("估算中…", "estimating…")) + '</span></div>';
        }
      }
      inner += '<div class="zu-sl-body">' + mainBlock;
      /* v242:胶囊仅估算/会话均两态(设计图「完成态·无会话均」无胶囊);real 数值仍吃档位色 */
      if (st.band && st.kind !== "real")
        inner += '<div class="zu-speed-bandtag"><b class="' + st.band.cls + '" style="font-weight:600">' + esc(tpsBandText(st.band)) + '</b></div>';
      if (subLine) inner += '<div class="zu-sl-note">' + esc(subLine) + '</div>';   // v235：无图表时保留「最近一段」读数（v218 语义）
      if (st.noteText) inner += '<div class="zu-sl-note">' + esc(st.noteText) + '</div>';
      inner += '</div>';
      if (segs && segs.length) {
        /* v240：左卡下半区「最近 N 段」概览（峰值/最低/最新，取自右侧同一组真实分段），填补留白 */
        var mx = segs[0].v, mn = segs[0].v;
        for (var si = 1; si < segs.length; si++) { if (segs[si].v > mx) mx = segs[si].v; if (segs[si].v < mn) mn = segs[si].v; }
        var lastV = segs[segs.length - 1].v;
        function sc(lb, val) {
          var bd = tpsBand(val);
          return '<span class="zu-sl-stat"><i>' + esc(lb) + '</i><b' + (bd ? ' class="' + bd.cls + '"' : "") + '>' + val.toFixed(1) + '</b></span>';
        }
        inner += '<div class="zu-sl-stats">' + sc(L("峰值", "Peak"), mx) + sc(L("最低", "Low"), mn) + sc(L("最新", "Latest"), lastV) + '</div>';
      }
      return inner;
    }
    var chart = speedChartHTML(o.segs, o.segsHover, o);
    var leftInner = o.status ? speedLeftHTML(o.status,
        (!chart && o.subLabel && o.sub) ? o.subLabel + " " + o.sub + " t/s" : "", chart ? o.segs : null) :
      hero + (o.leftNote ? '<div class="zu-speed-note">' + esc(o.leftNote) + '</div>' : "");
    var body = chart
      ? '<div class="zu-speed-body"><div class="zu-speed-left">' + leftInner + '</div>' + chart + '</div>'
      : (o.status
        ? '<div class="zu-speed-hero"><div class="zu-stat-kpi">' + leftInner + '</div></div>'
        : '<div class="zu-speed-hero">' + hero + '</div>');
    var basis = '';
    var timeRow = (o.timeStart || o.timeEnd)
      ? '<div class="zu-pj-time"><b>' + esc(L("时间范围", "Time span")) + '</b><span>' +
        (o.timeStart ? esc(o.timeStart) : "—") + " — " + (o.timeEnd ? esc(o.timeEnd) : "—") + '</span></div>'
      : '';
    if (o.basisTitle && chart) {
      /* v239（设计图）：「统计口径」左标题 + 右侧各段以竖线分隔横排，时间范围同卡下一行（无脚注） */
      var bparts = "";
      var bts = o.basisText || [];
      for (var bj = 0; bj < bts.length; bj++) bparts += '<span>' + esc(bts[bj]) + '</span>';
      basis = '<div class="zu-basis"><div class="zu-legend-title">' + esc(o.basisTitle) + '</div><div class="zu-basis-v">' + bparts + timeRow + '</div></div>';
      timeRow = "";
    } else if (o.basisTitle) {
      basis = '<div class="zu-legend-head" style="margin-top:16px"><div class="zu-legend-title">' + esc(o.basisTitle) + '</div></div>';
      for (var bi = 0; bi < o.basisText.length; bi++) {
        basis += '<div class="zu-stat-note">' + esc(o.basisText[bi]) + '</div>';
      }
    }
    var foot = '';
    for (var fi = 0; !chart && o.foot && fi < o.foot.length; fi++) {
      foot += '<div class="zu-stat-note">' + esc(o.foot[fi]) + '</div>';
    }
    return '<div class="zu-stat-tip zu-stat-tip--speed">' +
      '<style>.zusage-tip-root:has(.zu-stat-tip--speed){max-width:min(860px,calc(100vw - 24px))!important}</style>' +
      '<div class="zu-stat-head"><div class="zu-stat-title">' + esc(L("生成速度", "Generation speed")) + '</div>' +
      (o.scope ? '<div class="zu-stat-scope">' + esc(o.scope) + '</div>' : "") + '</div>' +
      body +
      (o.legend === false ? "" : tpsBandLegend(o.curCls, !!chart)) +
      basis + timeRow + foot + '</div>';
  }
  function tpsBandLegend(curCls, inline) {
    /* v215：两行五列网格（窄窗口重排）；范围文字保持原档位类着色（色点仅辅助，
     * 继承同一 currentColor），当前档位轻描边；当前档位按主读数真实档位判定。 */
    /* v239（设计图）：带图表的速度卡图例改「左标题 + 右侧单行 10 档横排」（窄窗 wrap），无「t/s」单位角标 */
    var out = inline
      ? '<div class="zu-legend-row"><div class="zu-legend-title">' + L("颜色对照", "Colour guide") + '</div><div class="zu-legend-grid zu-legend-inline">'
      : '<div class="zu-legend-head"><div class="zu-legend-title">' + L("颜色对照", "Colour guide") + '</div><div class="zu-legend-unit">t/s</div></div>' +
      '<div class="zu-legend-grid">';
    for (var i = TPS_BANDS.length - 1; i >= 0; i--) {
      var b = TPS_BANDS[i];
      var isCur = curCls && b.cls === curCls;
      out += '<span class="zu-legend-item' + (isCur ? " cur" : "") + '"><span class="' + b.cls + ' zu-legend-dot dot-c"></span><b class="' + b.cls + '">' +
        (b.lo === 0 ? "&lt;40" : b.hi ? b.lo + "–" + b.hi : "≥2000 Ultra") + "</b></span>";
    }
    return out + (inline ? "</div></div>" : "</div>");
  }
  /* v232 速度柱状图数据规整：快照 sess.speed_segs（当前会话最近 ≤10 个有效 main_turn 轮，
   * Python 侧 avg_tps 同款口径产出 {v: 原始 t/s, t: 轮完成时间 ms} 升序；v250 起按轮
   * 聚合并随段携带悬停卡明细 m/i/o/n/c）。渲染端只做防御：无该键（旧远端快照/旧冷
   * 主进程）返回 null = 不画图（与 avg_tps 缺省同哲学）；有效轮过滤非有限/非正值，
   * 同刻同值去重，升序截最近 10（v240：17→10）。明细字段逐项校验通过才透传——旧
   * 快照/远端旧行缺字段即省略，悬停卡按行判空不渲染（热文件先于冷文件部署是常态）。 */
  function speedSegsOf(sess) {
    var raw = sess && sess.speed_segs;
    if (!raw || typeof raw.length !== "number") return null;
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      var v = s && typeof s.v === "number" ? s.v : NaN;
      var t = s && typeof s.t === "number" ? s.t : 0;
      if (!isFinite(v) || v <= 0 || !isFinite(t) || t <= 0) continue;
      var key = t + "@" + Math.round(v * 100);
      if (seen[key]) continue;
      seen[key] = 1;
      var seg = { v: v, t: t };
      if (typeof s.m === "string" && s.m && s.m.length <= 200) seg.m = s.m;   // 防畸形远端超长名全文进 title/aria
      if (typeof s.i === "number" && isFinite(s.i) && s.i >= 0) seg.i = s.i;
      if (typeof s.o === "number" && isFinite(s.o) && s.o > 0) seg.o = s.o;
      if (typeof s.n === "number" && isFinite(s.n) && s.n >= 1) seg.n = Math.round(s.n);
      if (typeof s.c === "number" && isFinite(s.c) && s.c >= 0) seg.c = s.c;
      out.push(seg);
    }
    out.sort(function (a, b) { return a.t - b.t || a.v - b.v; });
    return out.length > 10 ? out.slice(out.length - 10) : out;
  }
  /* v232 最近 N 轮竖向柱状图（现 10 轮;纯字符串构造，随 speedCardHTML 走同一条签名幂等重建
   * 链；悬停段下标由实例闭包经 o.segsHover 传入，编进串里 → 数据刷新整卡重建时高亮
   * 与信息卡自愈）。X 轴=分段真实完成时间（本地时区 MM-DD HH:mm，v250 起每个显示标签
   * 都带月日，稀疏间隔显示、首末恒留）；柱顶读数恒一位小数、与柱高水平居中；Y 轴 0 起
   * 整洁刻度，且按「信息卡横向覆盖最右侧约一半柱」的约束迭代刻度，保证最高柱的柱顶
   * 读数不会被信息卡压住。轮值 ≥1000 t/s（读数 6 字符）时挂 wide 类：图表横滚，读数
   * 永不挤压重叠。悬停信息卡（v250）：时间全格式 yyyy-MM-dd HH:mm:ss + 模型/Token 用量/
   * 请求次数/预估费用逐行判空渲染（格式化回调 o.fmtTok/o.fmtCnt/o.fmtMoney 由调用点
   * 传入，切片/直调缺回调或旧快照缺字段即省略整行）。 */
  function speedChartHTML(segs, hoverIdx, o) {
    if (!segs || !segs.length) return "";
    var n = segs.length, i, s;
    if (!(hoverIdx >= 0 && hoverIdx < n)) hoverIdx = -1;   // v240：信息卡仅悬停/聚焦柱体时展示（用户再次拍板，撤销 v239 常驻）
    function esc2(x) { return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function two(v) { return (v < 10 ? "0" : "") + v; }
    function tParts(t) {
      var d = new Date(t);
      return [two(d.getMonth() + 1) + "-" + two(d.getDate()), two(d.getHours()) + ":" + two(d.getMinutes())];
    }
    function tFull0(t) {   // 悬停卡 k 行全格式时间（v250；置于函数顶层级，不依赖块级函数提升）
      var d = new Date(t);
      return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
        " " + two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
    }
    var maxV = 0, maxLen = 3;
    for (i = 0; i < n; i++) {
      if (segs[i].v > maxV) maxV = segs[i].v;
      var len = segs[i].v.toFixed(1).length;
      if (len > maxLen) maxLen = len;
    }
    /* v250：悬停轮的明细行（模型/Token/请求·费用）提前到几何计算前构建——信息卡高度
     * 按实际行数校准（36 基础 k+v 行 + 每行 14 = 行高 12 + 行距 2），明细缺席（旧快照/
     * 缺格式化回调）不虚占柱顶读数净空。行构建条件与下方 meta 拼装一一对应。 */
    var hMeta = "";
    if (hoverIdx >= 0) {
      var hv0 = segs[hoverIdx];
      var hasNum0 = function (x) { return typeof x === "number" && isFinite(x); };
      if (hv0.m) {
        hMeta += '<div class="zu-sc-card-m" title="' + esc2(hv0.m) + '">' + esc2(L("模型 ", "Model ")) + esc2(hv0.m) + '</div>';
      }
      if (hasNum0(hv0.i) && hasNum0(hv0.o) && isFinite(hv0.i + hv0.o) && o && typeof o.fmtTok === "function") {
        var tokLine0 = L("Token ", "Tokens ") + o.fmtTok(hv0.i + hv0.o) +
          L("（输入 ", " (in ") + o.fmtTok(hv0.i) + L(" · 输出 ", " · out ") + o.fmtTok(hv0.o) + L("）", ")");
        hMeta += '<div class="zu-sc-card-m" title="' + esc2(tokLine0) + '">' + esc2(tokLine0) + '</div>';
      }
      if (hasNum0(hv0.n) && hv0.n >= 1) {
        var reqLine0 = L("请求 ", "Requests ") + (o && typeof o.fmtCnt === "function" ? o.fmtCnt(hv0.n) : String(Math.round(hv0.n))) + L(" 次", " req");
        if (hasNum0(hv0.c) && o && typeof o.fmtMoney === "function") reqLine0 += L(" · 预估 ", " · est. ") + o.fmtMoney(hv0.c);
        hMeta += '<div class="zu-sc-card-m" title="' + esc2(reqLine0) + '">' + esc2(reqLine0) + '</div>';
      }
    }
    /* Y 轴：整洁刻度（1/2/2.5/5 ×10^k 阶梯，4 分割；跨档过粗时退 5 分割避免刻度
     * 跳档）。约束：信息卡（固定字号，横向盖住最右约一半柱）span 内柱的
     * 柱顶读数必须完整落在卡下方 → 卡span内柱高上限 (H-卡高-读数行)/H，其余柱
     * (H-读数行)/H；取满足约束的最小 yMax。读数行 16px = 10px 固定字高 + 4px 间距；
     * 几何全固定字号，不随宿主字号漂移。 */
    var H = 160, LBL = 16;
    /* v242:36=基础卡体实高 ~35.6px（k 12+值 15.6+padding 6+边框 2）向上取整；
     * v250 每明细行 +14（行高 12+行距 2），按悬停轮实际渲染的行数实算 */
    var CARD_H = 36 + (hMeta.match(/class="zu-sc-card-m"/g) || []).length * 14;
    var capIn = (H - CARD_H - LBL) / H, capOut = (H - LBL) / H;
    /* v242:信息卡实宽上限 ~210px,窄窗 plot min-width 340 时占比可达 62%——旧 0.3 假设
     * 会让卡盖住 span 外柱的读数;按最坏一半取 span(宽窗略保守,仅刻度更从容);
     * 默认未悬停（hoverIdx<0）不渲染信息卡，仅按 capOut 留柱顶读数净空，补充 6/7.5 阶梯防 198→400 跳档空旷 */
    var spanFrom = Math.max(0, n - Math.ceil(n * 0.5)), spanMax = 0;
    for (i = spanFrom; i < n; i++) if (segs[i].v > spanMax) spanMax = segs[i].v;
    var need = Math.max(maxV, hoverIdx >= 0 ? spanMax / capIn : 0, maxV / capOut);
    var yMax = 0, step = 0, div = 4;
    for (var K = 0; K <= 6 && !yMax; K++) {
      var mant = [1, 2, 2.5, 5, 6, 7.5];
      for (var kk = 0; kk < mant.length; kk++) {
        var st = mant[kk] * Math.pow(10, K);
        if (st * 4 >= need) { yMax = st * 4; step = st; div = 4; break; }
        if (st * 5 >= need) { yMax = st * 5; step = st; div = 5; break; }
      }
    }
    if (!yMax) { step = Math.pow(10, Math.ceil(Math.log(Math.max(maxV, 1)) / Math.LN10)); yMax = step * 4; div = 4; }
    var ticks = [];
    for (i = 0; i <= div; i++) ticks.push(step * i);
    /* X 轴稀疏守卫：列距不足 44px/标签时隔列显示（首末恒显示；末 2 柱相邻都会命中
     * 时弃 n-2 保 n-1）。44=最小标签间距、500=满宽 pitch 估算；v240 起 n≤10 时 500/n≥50
     * 恒 xEvery=1（现役死机制，仅作轮数上调/窄窗再缩的护栏;wide 由 plot 420 横滚兜底）。
     * v250（用户规格）：每个显示标签都渲染月日+时间两行，不再同日去重。 */
    var xEvery = Math.max(1, Math.ceil(44 / Math.max(500 / n, 1)));
    var wide = maxLen >= 6;
    function xShown(i2) {
      if (i2 === n - 1) return true;
      if (i2 === n - 2 && (n - 1) % xEvery !== 0) return false;
      return i2 % xEvery === 0;
    }
    var cols = "";
    for (i = 0; i < n; i++) {
      s = segs[i];
      var band = tpsBand(s.v);
      var isLast = i === n - 1, isCur = i === hoverIdx;
      var hPct = Math.max(1.2, Math.round(s.v / yMax * 1000) / 10);
      var tp = tParts(s.t);
      var segNo = L("第 " + (i + 1) + " 轮", "Turn " + (i + 1));
      var bandTxt = band ? tpsBandText(band) : "";
      var showX = xShown(i);
      cols += '<div class="zu-sc-col' + (isLast ? " latest" : "") + (isCur ? " cur" : "") +
        '" role="img" tabindex="0" data-i="' + i + '" aria-label="' + esc2(segNo + "，" + s.v.toFixed(1) + " t/s，" +
          tp[0] + " " + tp[1] + (bandTxt ? "，" + bandTxt : "")) + '">' +
        '<span class="zu-sc-vz"><span class="zu-sc-val' + (isLast ? " latest" : "") + '">' + s.v.toFixed(1) + '</span>' +
        '<i class="zu-sc-bar' + (band ? " " + band.cls : "") + '" style="height:' + hPct + '%"></i></span>' +
        '<span class="zu-sc-x">' + (showX ? "<b>" + tp[0] + "</b><b>" + tp[1] + "</b>" : "") + '</span>' +
        '</div>';
    }
    /* v240：信息卡仅悬停/聚焦柱体时渲染（v239 常驻卡已被用户撤销），悬停最新段时带
     * 「（最新）」角标；卡下方一条虚线竖线连到该柱读数（仅该柱落在卡横向覆盖范围内时画，
     * 范围外的柱与卡无几何关联，不画悬空线）。k 行时间全格式 yyyy-MM-dd HH:mm:ss（v250
     * 用户规格）；轮明细行（模型/Token 用量含输入输出拆分/请求次数/预估费用）已在几何
     * 计算前构建为 hMeta（行数参与 CARD_H 校准），此处直接拼装。 */
    var card = "";
    if (hoverIdx >= 0) {
    var hv = segs[hoverIdx], hband = tpsBand(hv.v), hLatest = hoverIdx === n - 1;
    var hTag = hLatest ? L("（最新）", " (latest)") : (hband ? L(hband.zh, hband.en) : "");
    card = '<div class="zu-sc-card"><div class="zu-sc-card-k">' + esc2(L("第 " + (hoverIdx + 1) + " 轮", "Turn " + (hoverIdx + 1)) +
      " · " + tFull0(hv.t)) + '</div><div class="zu-sc-card-v' + (hband ? " " + hband.cls : "") + '">' +
      hv.v.toFixed(1) + L(" t/s", " t/s") + (hTag ? '<i>' + esc2(hTag) + '</i>' : "") + '</div>' + hMeta + '</div>';
    if (hoverIdx >= spanFrom) {
      var lblTop = Math.round(H * (1 - Math.max(1.2, Math.round(hv.v / yMax * 1000) / 10) / 100)) - LBL;
      if (lblTop - CARD_H >= 3)
        card += '<i class="zu-sc-lead' + (hband ? " " + hband.cls : "") + '" style="left:' +
          (Math.round((hoverIdx + 0.5) / n * 10000) / 100) + '%;top:' + CARD_H + 'px;height:' + (lblTop - CARD_H) + 'px"></i>';
    }
    }
    var grid = "";
    for (i = 0; i < ticks.length; i++) {
      var pct = Math.round(ticks[i] / yMax * 1000) / 10;
      grid += '<i style="bottom:' + pct + '%"' + (ticks[i] ? "" : ' data-base="1"') + '></i>';
    }
    var gutter = "";
    for (i = 0; i < ticks.length; i++) {
      /* 最高档刻度数字挂到线内侧（wrap 纵向裁切，线外侧上半会被剪） */
      gutter += '<i' + (i === ticks.length - 1 ? ' class="top" style="bottom:calc(100% - 13px)' :
        ' style="bottom:' + (Math.round(ticks[i] / yMax * 1000) / 10) + '%') + '">' + ticks[i] + '</i>';
    }
    return '<div class="zu-speed-chart"><div class="zu-sc-head"><span class="zu-sc-title">' +
      esc2(L("最近 " + n + " 轮", "Last " + n + " turns")) + '</span><span class="zu-sc-sub">' +
      esc2(L("按完成顺序 · 从旧到新", "completion order · old → new")) + '</span>' +
      '<span class="zu-sc-unit">' + esc2(L("单位：t/s", "unit: t/s")) + '</span></div>' +
      '<div class="zu-sc-wrap' + (wide ? " wide" : "") + '"><div class="zu-sc-plot">' +
      '<span class="zu-sc-gutter">' + gutter + '</span><span class="zu-sc-grid">' + grid + '</span>' +
      '<span class="zu-sc-bars">' + cols + '</span>' + card + '</div></div></div>';
  }
  /* 返回 null = 调用方应把这当成"没有可展示的桥接视图"处理（回退 DB/不渲染），
   * 而不是当成"确定性地算出了没有速度"。v97：第三参 subSum = 子代理速率桥的合计
   * 视图（{rate, at, count}）——Agent 工具运行期优先展示**所有运行中子代理**的
   * 估算 tok/s 之和（并行 ≥2 个时动词后缀 ×N；运行中请求未入库，DB 无数据；
   * 3 秒未刷新即视为过期不显示），缺席时退回工具状态词 + 耗时。 */
  function zuBarSpeedView(stats, charsPerToken, subSum, sessAvg) {
    /* v235：除原有 text/cls/phase/band/latest/word 外，追加结构化字段供 tooltip 左卡
     * 分层渲染（kind/statusText/nameText/nameFull/elapsedText/speedValue/
     * speedIsEstimated/speedSource/activeCount/noteText）——状态判断仍全部来自本
     * 状态机，消费端不得解析 text 文案反推状态；原有字段语义与拼装逐字保留。 */
    if (!stats.complete) {
      // 工具执行期间优先显示与消息流同款的状态词（读取中/编辑中…+已耗时），
      // 让悬浮条与 toolCall 行状态对应；没有工具在跑才退回字符估算/存活心跳。
      if (stats.runningTool) {
        var verb = zuToolVerb(stats.runningTool.name);
        /* v158：Skill 运行期显示「技能名·执行中」（如「查阅·执行中」），名字取不到时
         * 保持「运行技能中」；计时后缀照旧。 */
        var skFull = "", skName = "";
        if (stats.runningTool.name === "Skill" && typeof stats.runningTool.inputText === "string") {
          skFull = zuSkillBaseName(stats.runningTool.inputText);   // v235：全名供左卡 title/两行展示
          skName = skFull;
          if (skName.length > 24) skName = skName.slice(0, 24) + "…";
          if (skName) verb = skName + L("·执行中", "·executing");
        }
        if (stats.runningTool.name === "Agent" && subSum && subSum.rate != null && subSum.count > 0 &&
            typeof subSum.at === "number" && Date.now() - subSum.at <= 3000)
          return { cls: "dim",
                   text: verb + (subSum.count > 1 ? " ×" + subSum.count : "") +
                     L(" · 估 ", " · est ") + subSum.rate.toFixed(1) + L(" t/s", " t/s"),
                   phase: "tool",
                   kind: "subagent", statusText: L("子代理运行中", "Sub-agents running"),
                   activeCount: subSum.count, speedValue: subSum.rate,
                   speedIsEstimated: true, speedSource: "subagent",
                   noteText: L(subSum.count + " 个子代理合计（估算）", subSum.count + " sub-agent(s) combined (est.)") };
        /* v181（v187 补回，PR #161 合并时遗漏消费分支）：宿主把当前段尾部连续 ≥2 的只读工具行
         * 合成「查阅」组、非只读 shell 合成「终端」组（顶栏「查阅 · 正在执行」同源，组标题是
         * 渲染层合成的）——运行行落在组尾时状态词跟随组标签而不是逐工具动词，与消息流一致；
         * 计时锚定组首行 startedAt（组从首行起算），缺失回退运行行起点。数据由 turn-stats 的
         * runningGroupOf 提供（Skill 行本身是组边界，与上面的技能名分支互斥不冲突）。 */
        var grp = stats.runningGroup;
        var grpKind = "";
        if (grp && grp.kind === "explore") { verb = L("查阅·执行中", "Explore·executing"); grpKind = "explore"; }
        else if (grp && grp.kind === "terminal") { verb = L("终端·执行中", "Terminal·executing"); grpKind = "terminal"; }
        var st = grp && grp.startedAt != null ? grp.startedAt : stats.runningTool.startedAt;
        var elapsed = "";
        if (typeof st === "number" && st > 0 && Date.now() >= st) {
          elapsed = ((Date.now() - st) / 1000).toFixed(1) + "s";   // v151 去中点 + v153 执行中（用户规格）
          verb += " " + elapsed;
        }
        var base = { cls: "dim", text: verb, phase: "tool", word: true };   // v159：纯状态词带流光（宿主 zcode-loading-label 同款）
        if (grpKind)
          return Object.assign(base, { kind: "toolgroup",
            statusText: L("工具组执行中", "Tool group running"),
            nameText: grpKind === "explore" ? L("查阅", "Explore") : L("终端", "Terminal"),
            elapsedText: elapsed,
            noteText: L("工具组 · 正在执行", "Tool group · executing") });
        if (skName)
          return Object.assign(base, { kind: "skill",
            statusText: L("Skill 执行中", "Executing skill"),
            nameText: skName, nameFull: skFull, elapsedText: elapsed,
            noteText: L("Skill · 正在执行", "Skill · executing") });
        base.kind = "tool";
        base.statusText = L("工具执行中", "Tool running");
        base.nameText = zuToolVerb(stats.runningTool.name);
        base.elapsedText = elapsed;
        base.noteText = L("工具 · 正在执行", "Tool · executing");
        return base;
      }
      // 无工具且无可测字符流（首段未流出/字符停滞>2s，多数模型思考期对桥不可见，
      // 看到的就是时间在走）：按用户语义定为"思考中"——动效脑图标 + 本轮存活时长。
      // v116：存活时长锚定 turnHeader.startedAt（宿主创建 header 即恒写入 startedAt，
      // 源码 buildTurnHeaderRow 证实）——切走再切回重绑 tracker 后不再从 0 重计；
      // 缺 startedAt 的旧形状或时钟未及起点时回退首观测起算。
      if (stats.characterRate == null) {
        var t0 = Number.isFinite(stats.startedAt) && stats.startedAt > 0 ? stats.startedAt : 0;
        var elapsedMs = t0 && Date.now() >= t0 ? Date.now() - t0 : stats.observedMs;
        var seconds = Math.floor(elapsedMs / 1000);
        var hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
        seconds %= 60;
        // 中文数字与单位、时间段之间全部紧邻（1时1分10秒）；英文数字与单位紧邻、
        // 时段间留空格（1h 1m 10s，v126 用户要求）。不让等宽字体撑开数字与单位。
        var uh = L("时", "h"), um = L("分", "m"), us = L("秒", "s");
        var segGap = L("", " ");
        var parts = [];
        if (hours) parts.push(hours + uh);
        if (minutes) parts.push(minutes + um);
        if (seconds || !parts.length) parts.push(seconds + us);
        var thinkText = parts.join(segGap);
        return { cls: "dim", text: L("思考中…", "thinking…") + thinkText,
                 phase: "thinking", word: true,
                 kind: "thinking", statusText: L("思考中", "Thinking"),
                 elapsedText: thinkText,
                 noteText: L("生成尚未开始", "Generation not started") };
      }
      var est = stats.characterRate / (charsPerToken || DEFAULT_CHARS_PER_TOKEN);
      /* v127：估算也按原始估算值套同一张档位表（任务规格：估算态与完成态都分档；
       * 估算仍按本函数原有口径计算，切换逻辑不动）。非有限/负数估算保持中性 dim，
       * 绝不判成低速；工具期子代理合计「估 X t/s」嵌在状态词里，维持 dim 不分档。 */
      var vband = tpsBand(est);
      return { cls: vband ? vband.cls : "dim", band: vband || null,
               text: est.toFixed(1) + L(" t/s", " t/s"),
               /* phase 兜底 thinking：新轮刚开始（最后活动行还是 userInput）时
                * stats.phase 为 null，不兜底会让图标在这一瞬回闪电再切回脑（闪烁）。 */
               phase: stats.phase || "thinking",
               kind: "estimate", statusText: L("生成中（估算）", "Generating (est.)"),
               speedValue: est, speedIsEstimated: true, speedSource: "estimate",
               noteText: L("按进度估算", "Estimated from progress") };
    }
    /* 切换/重新绑定到一个会话时，桥接首次订阅就可能直接捞到一个老早之前已完成的
     * 轮次（这次 ingest 从未见过它处于未完成状态）。这种"历史存量"不是我们亲历的
     * 完成过程，详细字段也可能已被宿主精简——不该把它当成"刚刚发生、算出来没速度"
     * 显示给用户（会被误读成这个会话突然坏了），交回调用方当作无桥数据处理。 */
    if (!stats.observedLive) return null;
    /* 完成但缺口径（宿主完成时 outputTokens/modelDurationMs 是可选字段，可能缺席）
     * 或零输出：同样回退 DB 最近一段值，绝不显示刺眼的"速度不可用"——那会被读成
     * "这个会话坏了"，而真相只是"这一轮的详细字段暂时没有"。DB 也没有值时调用方
     * 自然整枚 chip 不渲染。 */
    if (stats.tokenRate == null || !zuHasMeaningfulOutput(stats)) return null;
    /* v127：完成态真实值按 TPS_BANDS 分档；非有限/负数（宿主字段异常）当缺口径
     * 处理返回 null，交回调用方回退 DB 最近一段，绝不套低速档。 */
    var band = tpsBand(stats.tokenRate);
    if (!band) return null;
    /* 会话平均为主（用户拍板）：完成态主数字改会话加权平均（zusage.py 快照 avg_tps，
     * 覆盖本轮真实值），最近一轮真实值放 latest 供 tooltip 展开。avg 缺席
     * （旧远端快照/轻量行给 0）时行为不变。 */
    var avg = (typeof sessAvg === "number" && isFinite(sessAvg) && sessAvg > 0) ? sessAvg : 0;
    if (avg) {
      var aband = tpsBand(avg) || band;
      return { cls: aband.cls, band: aband,
               text: L("均", "avg ") + (avg % 1 ? avg.toFixed(1) : String(avg)) + L(" t/s", " t/s"),
               phase: null, latest: stats.tokenRate,
               kind: "avg", statusText: L("生成完成", "Generation complete"),
               speedValue: avg, speedIsEstimated: false, speedSource: "avg",
               noteText: L("会话加权平均", "Weighted average") };
    }
    return { cls: band.cls, band: band, text: stats.tokenRate.toFixed(1) + L(" t/s", " t/s"), phase: null,
             kind: "real", statusText: L("生成完成", "Generation complete"),
             speedValue: stats.tokenRate, speedIsEstimated: false, speedSource: "real",
             noteText: L("本轮实际速度", "Actual speed this turn") };
  }
  /* ---------- v254 生成速度 Tooltip 重构：双 Tab / 维度 / 16 柱 / hover 五字段 ----------
   * 数据面 = 快照顶层 speed_history（zusage 真实库有界扫描，单一轮表；短键 + 索引表）。
   * 全部筛选与聚合都在纯函数里完成，不新增 IPC/定时器/DOM 监听：Tab/dim/柱 hover 经
   * tip 本体既有事件委托改实例闭包状态，再由 speedTipRebuild 重编整卡串（签名幂等）。
   * 旧 speedCardHTML/speedChartHTML/speedSegsOf 逐字保留供精简 chip 与旧快照回退。 */
  var SPD_RANGES = ["recent", "session", "project", "all"];
  var SPD_PERIODS = ["recent", "today", "week", "month", "all"];
  var SPD_BARS_MAX = 16;
  function SPD_L(zh, en) { return L(zh, en); }
  function spdEsc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function spdNum(x) { return typeof x === "number" && isFinite(x) ? x : 0; }
  function spd2(v) { return (v < 10 ? "0" : "") + v; }
  function spdDate(ms) { return new Date(ms); }
  /* 紧凑时间胶囊：11/05 14:48 – 16:06（跨日/跨年补日期），完整值走 title */
  function spdRangeText(a, b) {
    if (!a || !b) return SPD_L("暂无数据", "no data");
    var d1 = spdDate(a), d2 = spdDate(b);
    /* v273：智能紧凑——同日/跨日不带年，跨月或跨年两端带年 */
    var p = function (d, wy) {
      return (wy ? d.getFullYear() + "/" : "") + spd2(d.getMonth() + 1) + "/" + spd2(d.getDate());
    };
    var hm = function (d) { return spd2(d.getHours()) + ":" + spd2(d.getMinutes()); };
    var sameDay = d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
    var crossMonth = d1.getFullYear() !== d2.getFullYear() || d1.getMonth() !== d2.getMonth();
    return sameDay ? p(d1, crossMonth) + " " + hm(d1) + " – " + hm(d2)
      : p(d1, crossMonth) + " " + hm(d1) + " – " + p(d2, true) + " " + hm(d2);
  }
  function spdFull(ms) {
    var d = spdDate(ms);
    return d.getFullYear() + "-" + spd2(d.getMonth() + 1) + "-" + spd2(d.getDate()) + " " +
      spd2(d.getHours()) + ":" + spd2(d.getMinutes()) + ":" + spd2(d.getSeconds());
  }
  /* 柱底短标签：一轮一柱时只留 时分，日/月桶沿用各自粒度；
   * 完整年月日时分秒只进 hover 信息卡，不塞进 30px 柱宽。 */
  function spdShort(ms, unit) {
    var d = spdDate(ms);
    if (unit === "turn") return spd2(d.getHours()) + ":" + spd2(d.getMinutes());
    return spdLabel(ms, unit, true);
  }
  function spdRangeFull(a, b) {
    return (a ? spdFull(a) : "—") + " – " + (b ? spdFull(b) : "—");
  }
  /* 轮表解包：t 是相对上一轮完成时刻的 delta（升序还原），s/msl 是索引表下标。
   * 任何字段缺失/非法都丢弃该轮，不让畸形远端/旧快照污染统计。 */
  function spdUnpack(h) {
    if (!h || !h.turns || typeof h.turns.length !== "number" || !h.sids || !h.snames) return null;
    var sids = h.sids, snames = h.snames, pids = h.pids || [], mnames = h.mnames || [];
    var out = [], prev = 0;
    for (var i = 0; i < h.turns.length; i++) {
      var r = h.turns[i];
      if (!r || typeof r.t !== "number" || !isFinite(r.t)) continue;
      var t = prev + r.t;
      prev = t;
      var outv = spdNum(r.out), ms = spdNum(r.ms);
      if (!(outv > 0 && ms > 0) || !(typeof r.s === "number" && sids[r.s])) continue;
      var models = [];
      if (r.msl && typeof r.msl.length === "number") {
        for (var j = 0; j < r.msl.length; j++) {
          var p = r.msl[j];
          if (p && typeof p[0] === "number" && mnames[p[0]] && spdNum(p[1]) > 0)
            models.push({ m: mnames[p[0]], o: spdNum(p[1]) });
        }
      }
      var meta = pids[r.s] || ["", ""];
      out.push({ s: r.s, sid: sids[r.s], sname: snames[r.s] || sids[r.s],
        pid: meta[0] || "", pname: meta[1] || sids[r.s],
        t: t, b: spdNum(r.b) || t, out: outv, ms: ms,
        i: spdNum(r.i), o: spdNum(r.o), n: spdNum(r.n), models: models,
        c: (typeof r.c === "number" && isFinite(r.c)) ? r.c : null, cf: !!r.cf });
    }
    return { turns: out, sid: h.sid || "", source: h.source || "", truncated: !!h.truncated };
  }
  /* 统一聚合器：任何桶/柱/均值都走 Σ有效输出 ÷ Σ生成窗口，绝不逐轮算术平均。
   * 每柱携带 hover 五字段所需完整元数据（时间区间/速度/模型/Token/请求数/费用完整性）。 */
  function spdAggregate(rows) {
    var out = 0, ms = 0, i = 0, o = 0, n = 0, turns = 0, models = {}, c = 0, priced = false, costFull = true;
    var t0 = Infinity, t1 = 0, last = 0;
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      out += r.out; ms += r.ms; i += r.i; o += r.o; n += r.n; turns++;
      if (r.b < t0) t0 = r.b;
      if (r.t > t1) t1 = r.t;
      if (r.t >= last) last = r.t;
      for (var j = 0; j < r.models.length; j++) {
        var m = r.models[j];
        models[m.m] = (models[m.m] || 0) + m.o;
      }
      if (r.c !== null) { c += r.c; priced = true; costFull = costFull && r.cf; }
      else costFull = false;
    }
    if (!ms) return null;
    var ml = [];
    for (var name in models) if (models[name] > 0) ml.push({ m: name, o: models[name] });
    ml.sort(function (a, b) { return b.o - a.o; });
    return { v: out / (ms / 1000), out: out, ms: ms, i: i, o: o, n: n, turns: turns,
      models: ml.slice(0, 8), modelCount: ml.length, t0: isFinite(t0) ? t0 : 0, t1: t1,
      last: last, c: priced ? c : null, costFull: priced && costFull };
  }
  /* 本地自然时间桶键：hour/day/week/month/quarter/year，轮归属只看完成时刻。 */
  function spdBucket(t, unit) {
    var d = spdDate(t), y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
    if (unit === "hour") return new Date(y, mo, day, d.getHours()).getTime();
    if (unit === "day") return new Date(y, mo, day).getTime();
    if (unit === "week") return new Date(y, mo, day - d.getDay()).getTime();
    if (unit === "month") return new Date(y, mo, 1).getTime();
    if (unit === "quarter") return new Date(y, Math.floor(mo / 3) * 3, 1).getTime();
    return new Date(y, 0, 1).getTime();
  }
  function spdNextBucket(t, unit) {
    var d = spdDate(t), y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
    if (unit === "hour") return new Date(y, mo, day, d.getHours() + 1).getTime();
    if (unit === "day") return new Date(y, mo, day + 1).getTime();
    if (unit === "week") return new Date(y, mo, day - d.getDay() + 7).getTime();
    if (unit === "month") return new Date(y, mo + 1, 1).getTime();
    if (unit === "quarter") return new Date(y, Math.floor(mo / 3) * 3 + 3, 1).getTime();
    return new Date(y + 1, 0, 1).getTime();
  }
  function spdLabel(t, unit, short) {
    var d = spdDate(t), md = spd2(d.getMonth() + 1) + "/" + spd2(d.getDate());
    if (unit === "hour") return short ? spd2(d.getHours()) + ":00" : md + " " + spd2(d.getHours()) + ":00";
    if (unit === "day") return md;
    if (unit === "week") return md;
    if (unit === "month") return d.getFullYear() + "/" + spd2(d.getMonth() + 1);
    if (unit === "quarter") return d.getFullYear() + " Q" + (Math.floor(d.getMonth() / 3) + 1);
    return String(d.getFullYear());
  }
  function spdPeriodPrefix(p) {
    return p === "today" ? SPD_L("今天", "Today") : p === "week" ? SPD_L("近 7 天", "Last 7 days")
      : p === "month" ? SPD_L("本月", "This month") : p === "recent" ? SPD_L("最近", "Recent")
      : SPD_L("历史", "History");
  }
  /* 20 种组合 + 3 维度的唯一入口。返回 {items, range, title, unit, dimension, notice}。
   * items 每柱 = spdAggregate 结果 + {label, full, a, b}，空数据不补位、不显 0 t/s。 */
  function spdAnalyze(h, sel) {
    var u = spdUnpack(h);
    if (!u) return null;
    var range = sel.range, period = sel.period, now = Date.now();
    /* v272：维度切换功能移除（用户裁定），图表恒按时间聚合；「项目」范围恢复当前项目
     * 语义（否则与「全部」完全等价），四 Tab 递进：最近=当前会话 16 轮 / 会话=当前
     * 会话全部 / 项目=当前项目全部会话 / 全部=全库，均按时间。 */
    var dim = "time";
    // paneSid 由调用点从本窗口/分栏可信身份注入（同一帧推给所有窗，绝不用帧里 sid）
    var paneSid = sel.sid || "";
    var panePid = "";
    for (var pi = 0; pi < u.turns.length; pi++) if (u.turns[pi].sid === paneSid) { panePid = u.turns[pi].pid; break; }
    var pool = u.turns, notice = "";
    if (range === "session" || range === "recent") pool = pool.filter(function (r) { return r.sid === paneSid; });
    else if (range === "project") pool = pool.filter(function (r) { return panePid && r.pid === panePid; });
    // 全部 + 远端身份：本地库不能冒充远端历史，明确降级到本会话并提示
    var remote = !!sel.remote;
    if (remote && range === "all") { range = "session"; pool = pool.filter(function (r) { return r.sid === paneSid; }); notice = SPD_L("远端会话仅显示本会话历史", "Remote pane: local session history only"); }
    if (u.truncated && !notice) notice = SPD_L("历史较长，仅统计最近可用轮次", "Long history: recent turns only");
    var a = 0, b = 0;
    var todayStart = new Date(now).setHours(0, 0, 0, 0);
    var weekStart = todayStart - 6 * 86400000;
    var monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
    if (period === "today") { a = todayStart; b = now; }
    else if (period === "week") { a = weekStart; b = now; }
    else if (period === "month") { a = monthStart; b = now; }
    if (a) pool = pool.filter(function (r) { return r.t >= a && r.t <= b; });
    // 范围「最近」先取该范围最近 16 个有效轮；时间「最近」再取 16（两者独立过滤）
    if (range === "recent") pool = pool.slice(-SPD_BARS_MAX);
    var items = [], unit = "", title = "", focusInfo = null;
    if (period === "recent") {
      pool = pool.slice(-SPD_BARS_MAX);
      for (var i = 0; i < pool.length; i++) {
        var agg = spdAggregate([pool[i]]);
        /* v263：跨日首柱带两行标签（MM/DD + HH:mm）；首个柱无前参照不标日 */
        var dayLabel = "";
        if (i) {
          var pd0 = spdDate(pool[i - 1].t), cd0 = spdDate(pool[i].t);
          if (pd0.getMonth() !== cd0.getMonth() || pd0.getDate() !== cd0.getDate())
            dayLabel = spd2(cd0.getMonth() + 1) + "/" + spd2(cd0.getDate());
        }
        if (agg) items.push(Object.assign(agg, { label: spdShort(pool[i].t, "turn"), dayLabel: dayLabel,
          full: spdFull(pool[i].b) + " – " + spdFull(pool[i].t),
          a: pool[i].b, b: pool[i].t, single: true }));
      }
      unit = "turn";
      title = SPD_L("最近 " + items.length + " 轮 · 生成速度", "Last " + items.length + " turns · speed");
    } else {
      // 按时间：跨度决定粒度；今天恒按小时（含空桶），其余按跨度自动分档
      if (pool.length) {
        var lo = Infinity, hi = 0;
        for (var q = 0; q < pool.length; q++) { if (pool[q].t < lo) lo = pool[q].t; if (pool[q].t > hi) hi = pool[q].t; }
        var span = hi - lo;
        if (period === "today") unit = "hour";
        else if (period === "week" || period === "month") unit = "day";
        else if (span <= 45 * 86400000) unit = "day";
        else if (span <= 370 * 86400000) unit = "month";
        else if (span <= 4 * 370 * 86400000) unit = "quarter";
        else unit = "year";
        var buckets = {}, bkeys = [];
        for (var w = 0; w < pool.length; w++) {
          var bk = spdBucket(pool[w].t, unit);
          if (!buckets[bk]) { buckets[bk] = []; bkeys.push(bk); }
          buckets[bk].push(pool[w]);
        }
        bkeys.sort(function (x, y) { return x - y; });
        // 今天：00:00→当前小时全桶，无数据显空柱而非零速度；
        // v273：有效桶 ≤3 且全桶 ≥4 时默认聚焦有效时段（speedSel.focus==="full" 切完整轴）
        if (period === "today") {
          bkeys = [];
          for (var hr = 0; hr <= new Date(now).getHours(); hr++) bkeys.push(todayStart + hr * 3600000);
          var fullKeys = bkeys.slice(0), realKeys = [];
          for (var fk = 0; fk < fullKeys.length; fk++) if ((buckets[fullKeys[fk]] || []).length) realKeys.push(fullKeys[fk]);
          if (sel.focus !== "full" && realKeys.length && realKeys.length <= 3 && fullKeys.length >= 4) bkeys = realKeys;
          focusInfo = { canToggle: true, applied: bkeys.length !== fullKeys.length,
            real: realKeys.length, total: fullKeys.length, unit: SPD_L("小时", "hours"),
            hint: sel.focus === "full" ? SPD_L("仅显示有记录时段", "showing recorded hours only") : "" };
        }
        for (var bi = 0; bi < bkeys.length; bi++) {
          var bk2 = bkeys[bi], rows = buckets[bk2] || [], bg = spdAggregate(rows);
          var nb = spdNextBucket(bk2, unit);
          items.push(bg ? Object.assign(bg, { label: spdLabel(bk2, unit, true), full: spdFull(bk2) + " – " + spdFull(Math.min(nb, now)), a: bk2, b: nb, single: false })
            : { v: null, label: spdLabel(bk2, unit, true), full: spdFull(bk2) + " – " + spdFull(nb), a: bk2, b: nb, empty: true });
        }
      }
      var unitName = { hour: SPD_L("每小时", "hourly"), day: SPD_L("每日", "daily"), week: SPD_L("每周", "weekly"),
        month: SPD_L("每月", "monthly"), quarter: SPD_L("每季度", "quarterly"), year: SPD_L("每年", "yearly") }[unit] || SPD_L("每日", "daily");
      var prefix = period === "today" ? SPD_L("今天", "Today") : period === "week" ? SPD_L("近 7 天", "Last 7 days")
        : period === "month" ? SPD_L("本月", "This month") : SPD_L("历史", "History");
      title = (range === "project" ? SPD_L("当前项目 · ", "Current project · ") : "") +
        prefix + " · " + unitName + SPD_L("平均速度", " average speed");
    }
    var real = items.filter(function (x) { return !x.empty; });
    var overall = spdAggregate(pool);
    var spanA = a || (pool.length ? pool[0].b : 0);
    var spanB = b || (pool.length ? pool[pool.length - 1].t : 0);
    if (period === "all" && pool.length) { spanA = pool[0].b; spanB = pool[pool.length - 1].t; }
    var peak = null, low = null, latest = null;
    for (var z = 0; z < real.length; z++) {
      if (!peak || real[z].v > peak.v) peak = real[z];
      if (!low || real[z].v < low.v) low = real[z];
      if (!latest || real[z].last > latest.last) latest = real[z];
    }
    /* v273：数据覆盖提示（真实桶计数，分母=窗口内已发生时段） */
    var cov = "";
    if (period === "today" && focusInfo) cov = SPD_L("有记录 " + focusInfo.real + "/" + focusInfo.total + " 小时",
      focusInfo.real + "/" + focusInfo.total + " hours with data");
    else if (period === "week" && real.length) cov = SPD_L("仅 " + real.length + "/7 天有记录",
      "only " + real.length + "/7 days with data");
    else if (period === "month" && real.length) cov = SPD_L("本月 " + real.length + "/" + spdDate(now).getDate() + " 天有记录",
      real.length + "/" + spdDate(now).getDate() + " days this month");
    /* v274：单点/双点稀疏时明确「不构成趋势」 */
    if (cov && real.length && real.length <= 2)
      cov += SPD_L(" · 暂无足够数据观察趋势", " · not enough data for a trend");
    return { items: items, real: real, overall: overall, range: range, period: period, dim: "time",
      dims: ["time"], title: title, unit: unit, spanA: spanA, spanB: spanB,
      cov: cov, focus: focusInfo,
      peak: peak, low: low, latest: latest, notice: notice, truncated: u.truncated };
  }

  function spdTabRow(group, list, cur, labels) {
    var out = '<div class="zu-sv-tabs" data-sv-group="' + group + '">';
    for (var i = 0; i < list.length; i++) {
      out += '<button type="button" class="zu-sv-tab' + (list[i] === cur ? " on" : "") +
        '" data-sv-group="' + group + '" data-sv-val="' + spdEsc(list[i]) + '"' +
        (list[i] === cur ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        spdEsc(labels[list[i]]) + "</button>";
    }
    return out + "</div>";
  }
  /* 顶部：标题 + 日历胶囊（紧凑时间，title 全格式）。窄窗优先缩日期不挤 Tab。 */
  function spdHeadHTML(an) {
    var ico = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>';
    var short = spdRangeText(an.spanA, an.spanB);
    return '<div class="zu-sv-head"><div class="zu-sv-title">' + spdEsc(SPD_L("生成速度", "Generation speed")) + "</div>" +
      '<div class="zu-sv-range" title="' + spdEsc(spdRangeFull(an.spanA, an.spanB)) + '">' + ico +
      '<span>' + spdEsc(short) + "</span></div></div>";
  }
  function spdFiltersHTML(an, sel) {
    var rl = { recent: SPD_L("最近", "Recent"), session: SPD_L("会话", "Session"),
      project: SPD_L("项目", "Project"), all: SPD_L("全部", "All") };
    var pl = { recent: SPD_L("最近", "Recent"), today: SPD_L("今天", "Today"),
      week: SPD_L("近 7 天", "7 days"), month: SPD_L("本月", "Month"), all: SPD_L("全部", "All") };
    /* v273：统一筛选工具栏——范围居左、时间居右（margin-left:auto），与下方统计卡/
     * 图表两缘对齐；窄窗 wrap 后时间组整体换行仍右对齐 */
    return '<div class="zu-sv-filter"><span class="zu-sv-flabel">' + spdEsc(SPD_L("范围", "Scope")) + "</span>" +
      spdTabRow("range", SPD_RANGES, an.range, rl) +
      '<span class="zu-sv-time"><span class="zu-sv-flabel">' + spdEsc(SPD_L("时间", "Time")) + "</span>" +
      spdTabRow("period", SPD_PERIODS, an.period, pl) + "</span>" +
      (an.notice ? '<div class="zu-sv-notice">' + spdEsc(an.notice) + "</div>" : "") + "</div>";
  }
  /* 左统计卡：当前状态（实时估算与历史均值分离）/ 主均值 / 档位 / 峰值·最低·最新 */
  function spdLeftHTML(an, live) {
    var avg = an.overall ? an.overall.v : null;
    var bd = avg != null ? tpsBand(avg) : null;
    var liveTxt = live && typeof live.speedValue === "number" && isFinite(live.speedValue) && live.speedValue > 0
      ? (live.speedValue % 1 ? live.speedValue.toFixed(1) : String(live.speedValue)) : "";
    /* 实时状态（工具执行中/思考中/生成中）与历史均值分离：状态只作独立 note，
     * 不再当整卡标题，避免「工具执行中 65.2 t/s」被误读成工具速度。 */
    var spdLiveStatus = live && live.statusText ? live.statusText : "";
    var main = avg != null ? (avg % 1 ? avg.toFixed(1) : String(avg)) : "—";
    var fmtV = function (x) { return x == null ? "—" : (x.v % 1 ? x.v.toFixed(1) : String(x.v)); };
    var stat = function (lb, x) {
      var b2 = x && x.v != null ? tpsBand(x.v) : null;
      return '<span class="zu-sl-stat"><i>' + spdEsc(lb) + "</i><b" + (b2 ? ' class="' + b2.cls + '"' : "") + ">" +
        spdEsc(fmtV(x)) + "</b></span>";
    };
    /* v273：实时状态（工具执行中等）并入标题行右侧轻量标识，不再混在指标之间 */
    return '<div class="zu-speed-left zu-sv-left"><div class="zu-sl-status">' +
      '<span class="zu-sl-title">' + spdEsc(SPD_L("历史统计", "History")) + "</span>" +
      (spdLiveStatus ? '<span class="zu-sl-sub">' + spdEsc(spdLiveStatus) + "</span>" : "") + "</div>" +
      '<div class="zu-sl-body"><div class="zu-sl-k">' + spdEsc(SPD_L("平均速度", "Average speed")) + "</div>" +
      '<div class="zu-sl-main"><span class="zu-sl-val' + (bd ? " " + bd.cls : " dim") + '">' + main +
      '</span><small class="zu-sl-unit">t/s</small></div>' +
      (bd ? '<div class="zu-speed-bandtag"><b class="' + bd.cls + '" style="font-weight:600">' +
        spdEsc(tpsBandText(bd)) + "</b></div>" : "") +
      /* v263：口径公式行删除（规格点名「删除大段统计口径文字」，语义由图例 ⓘ title 承载），
       * 说明行统一为「历史统计 · 不含进行中请求」；实时状态/生成中估算仍独立成行。 */
      (liveTxt ? '<div class="zu-sl-note">' + spdEsc(SPD_L("生成中估 ", "Generating est. ")) + liveTxt + " t/s</div>" : "") +
      "</div>" +
      '<div class="zu-sl-stats' + (an.real && an.real.length === 1 ? " zu-sl-solo" : "") + '">' + stat(SPD_L("峰值", "Peak"), an.peak) + stat(SPD_L("最低", "Low"), an.low) +
      stat(SPD_L("最新", "Latest"), an.latest) + "</div></div>";
  }
  /* 柱 hover 五字段卡：时间（聚合桶显完整区间）/ 速度（档位色）/ 模型（多模型 N 种）/
   * Token 总消耗（input 已含缓存、output 已含思考，不重复相加）/ 预估价格（缺失显暂无估价）。 */
  /* v270：聚合桶区间同日压缩（右侧只补时分秒），跨日全量；配 CSS 换行兜底，
   * 避免长区间被 nowrap 省略号截断（用户实报） */
  function spdCompactRange(a, b) {
    if (!a || !b) return spdFull(b || a || 0);
    var d1 = spdDate(a), d2 = spdDate(b);
    var hms = function (d) { return spd2(d.getHours()) + ":" + spd2(d.getMinutes()) + ":" + spd2(d.getSeconds()); };
    if (d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate())
      return spdFull(a) + " – " + hms(d2);
    return spdFull(a) + " – " + spdFull(b);
  }
  function spdCardHTML(item, hoverIdx, o) {
    if (!(hoverIdx >= 0) || !item || item.empty) return "";
    var bd = tpsBand(item.v);
    var cls = "zu-sv-card" + (bd ? " " + bd.cls : "");
    var modelTxt, modelFull;
    if (!item.models || !item.models.length) {
      modelTxt = SPD_L("未知模型", "Unknown model"); modelFull = modelTxt;
    } else if (item.modelCount > 1 || item.models.length > 1) {
      var n = item.modelCount || item.models.length;
      modelTxt = SPD_L("多模型（" + n + " 种）", n + " models");
      modelFull = item.models.slice(0, 4).map(function (m) { return m.m; }).join(", ") + (n > 4 ? " …" : "");
    } else {
      modelTxt = item.models[0].m; modelFull = modelTxt;
    }
    var tok = item.i + item.o;
    var tokLine = (o && typeof o.fmtTok === "function" ? o.fmtTok(tok) : String(tok)) +
      SPD_L(" token", " tokens");
    var sub = SPD_L("（输入 ", " (in ") + (o && typeof o.fmtTok === "function" ? o.fmtTok(item.i) : String(item.i)) +
      SPD_L(" · 输出 ", " · out ") + (o && typeof o.fmtTok === "function" ? o.fmtTok(item.o) : String(item.o)) + SPD_L("）", ")");
    var cost;
    if (!o || !o.fmtMoney) cost = '<span class="zu-sv-off">' + spdEsc(SPD_L("费用显示已关闭", "Cost display off")) + "</span>";
    else if (item.c === null) cost = '<span class="zu-sv-off">' + spdEsc(SPD_L("暂无估价", "Estimate unavailable")) + "</span>";
    else cost = spdEsc(o.fmtMoney(item.c)) + (!item.costFull ? '<i class="zu-sv-partial">' + spdEsc(SPD_L(" · 含兜底估价", " · partly estimated")) + "</i>" : "");
    var timeVal = spdCompactRange(item.a, item.b);
    return '<div class="' + cls + '" role="tooltip"><div class="zu-sv-crow"><span>' + spdEsc(SPD_L("时间", "Time")) +
      '</span><b class="zu-sv-twrap" title="' + spdEsc(item.full) + '">' + spdEsc(timeVal) + "</b></div>" +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("速度", "Speed")) + '</span><b class="zu-sv-cval' +
      (bd ? " " + bd.cls : "") + '">' + (item.v % 1 ? item.v.toFixed(1) : String(item.v)) + " t/s</b></div>" +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("模型型号", "Model")) + '</span><b title="' + spdEsc(modelFull) + '">' + spdEsc(modelTxt) + "</b></div>" +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("Token 总消耗", "Total tokens")) + '</span><b>' + spdEsc(tokLine) +
      '<small>' + spdEsc(sub) + "</small></b></div>" +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("预估价格", "Est. cost")) + "</span><b>" + cost + "</b></div></div>";
  }
  /* v274：统一图表布局参数入口（§5.1）——柱宽/间距/稀疏化密度由此一处决定，
   * 用数据密度驱动布局，不按 Tab 名写死。 */
  function spdChartLayout(n) {
    return {
      colPitch: 30,                                   /* 每柱占位列宽（柱 14px + 两侧留白） */
      spacerW: Math.max(240, n * 30 + 12),            /* plot 撑宽（少柱拉满容器、多桶横滚） */
      xEvery: Math.max(1, Math.ceil(n / 6)),          /* X 轴标签稀疏化 */
      valEvery: Math.max(1, Math.ceil(n / 8)),        /* 柱顶数值稀疏化（防 16 柱重叠） */
      single: n === 1
    };
  }
  /* 动态柱状图：细柱定宽居中、X 轴稀疏、Y 轴整洁刻度、无均值虚线。 */
  function spdChartHTML(an, hoverIdx, o) {
    var items = an.items, n = items.length;
    var L = spdChartLayout(n);
    /* v272：维度下拉移除；v273：数据覆盖提示 + 聚焦/完整轴切换按钮 */
    var head = '<div class="zu-sc-head"><span class="zu-sc-title">' + spdEsc(an.title) + "</span>" +
      (an.cov ? '<span class="zu-sc-cov">' + spdEsc(an.cov) + "</span>" : "") +
      (an.focus && an.focus.canToggle ?
        '<button type="button" class="zu-sv-focus" data-sv-focus="1">' +
        spdEsc(an.focus.applied ? SPD_L("显示完整时间轴", "Show full timeline")
          : SPD_L("仅显示有记录时段", "Recorded hours only")) + "</button>" : "") +
      (an.focus && an.focus.applied ? '<span class="zu-sc-cov">' + spdEsc(an.focus.hint) + "</span>" : "") +
      '<span class="zu-sc-unit">' + spdEsc(SPD_L("单位：t/s", "unit: t/s")) + "</span></div>";
    if (!n) return '<div class="zu-speed-chart zu-sv-chart">' + head +
      '<div class="zu-sv-empty">' + spdEsc(SPD_L("当前筛选无有效速度数据", "No rated turns for this filter")) +
      '<span class="zu-sv-empty-hint">' + spdEsc(SPD_L("尝试选择更长时间范围", "Try a longer time range")) + "</span></div></div>";
    var maxV = 0;
    for (var i = 0; i < n; i++) if (!items[i].empty && items[i].v > maxV) maxV = items[i].v;
    var yMax = 0, step = 0;
    var mant = [1, 2, 2.5, 5, 6, 7.5];
    for (var K = 0; K <= 6 && !yMax; K++) for (var kk = 0; kk < mant.length; kk++) {
      var st = mant[kk] * Math.pow(10, K);
      if (st * 4 >= maxV * 1.12) { yMax = st * 4; step = st; break; }
      if (st * 5 >= maxV * 1.12) { yMax = st * 5; step = st; break; }
    }
    if (!yMax) { step = Math.pow(10, Math.ceil(Math.log(Math.max(maxV, 1)) / Math.LN10)); yMax = step * 4; }
    var ticks = [], div = Math.round(yMax / step);
    for (var ti = 0; ti <= div; ti++) ticks.push(step * ti);
    var H = 148, xEvery = L.xEvery, valEvery = L.valEvery;
    function xShown(idx) {
      /* v263：跨日首柱（dayLabel）恒显示，日期信息不随稀疏化丢失 */
      return idx === n - 1 || idx === 0 || idx % xEvery === 0 || !!items[idx].dayLabel;
    }
    /* v274：柱顶数值稀疏化——n>8 时按 valEvery 抽稀（首末恒显、悬停柱恒显），
     * 未显示柱由 hover 信息卡兜底完整数值 */
    function valShown(idx, isCur) {
      if (isCur) return true;
      return n <= 8 || idx === n - 1 || idx === 0 || idx % valEvery === 0;
    }
    var cols = "";
    for (var c = 0; c < n; c++) {
      var it = items[c], isCur = c === hoverIdx, bd = it.empty ? null : tpsBand(it.v);
      var hPct = it.empty ? 0 : Math.max(1.2, Math.round(it.v / yMax * 1000) / 10);
      /* v263：跨日首柱两行标签（MM/DD + HH:mm，基类 .zu-sc-x 本就是 column flex） */
      var xTxt = "";
      if (xShown(c)) xTxt = (it.dayLabel ? "<b>" + spdEsc(it.dayLabel) + "</b>" : "") + "<b>" + spdEsc(it.label) + "</b>";
      cols += '<div class="zu-sc-col' + (isCur ? " cur" : "") + (it.empty ? " empty" : "") +
        (c === n - 1 ? " latest" : "") +
        '" role="img" tabindex="0" data-i="' + c + '" aria-label="' +
        spdEsc((it.dayLabel ? it.dayLabel + " " : "") + it.label + "，" + (it.empty ? SPD_L("无数据", "no data") : (it.v.toFixed(1) + " t/s"))) + '">' +
        '<span class="zu-sc-vz"><span class="zu-sc-val">' + (it.empty || !valShown(c, isCur) ? "" : it.v.toFixed(1)) + "</span>" +
        '<i class="zu-sc-bar' + (bd ? " " + bd.cls : "") + '" style="height:' + hPct + '%"></i></span>' +
        '<span class="zu-sc-x">' + xTxt + "</span></div>";
    }
    var grid = "", gutter = "";
    for (var g = 0; g < ticks.length; g++) {
      var pct = Math.round(ticks[g] / yMax * 1000) / 10;
      grid += '<i style="bottom:' + pct + '%"' + (ticks[g] ? "" : ' data-base="1"') + "></i>";
      gutter += '<i' + (g === ticks.length - 1 ? ' class="top" style="bottom:calc(100% - 13px)"' : ' style="bottom:' + pct + '%"') + ">" + ticks[g] + "</i>";
    }
    var card = "";
    if (hoverIdx >= 0 && items[hoverIdx]) {
      /* 信息卡默认在柱上方：按柱下标算水平位置并钳边（30px 列、柱组居中），
       * 顶部净空不足时由 CSS 翻到下方；不新增 DOM 监听，随整卡签名幂等重建。 */
      /* v273：plot 宽自适应后锚点改中心相对式——柱组居中于 plot，卡随柱水平偏移 */
      var off = Math.round((hoverIdx + 0.5 - n / 2) * L.colPitch - 126);
      var bdt = items[hoverIdx].empty ? null : tpsBand(items[hoverIdx].v);
      card = '<div class="zu-sv-card-anchor" style="left:calc(50% + ' + off + 'px)">' +
        spdCardHTML(items[hoverIdx], hoverIdx, o) + "</div>";
    }
    /* v273：plot 自适应——in-flow spacer 撑宽（多桶触发横滚），min-width 拉满容器，
     * 柱组 flex 居中；网格/Y 轴/hover 定位共享同一 plot 坐标系 */
    return '<div class="zu-speed-chart zu-sv-chart">' + head +
      '<div class="zu-sc-wrap"><div class="zu-sv-plot"><i class="zu-sv-spacer" style="width:' + L.spacerW + 'px"></i><span class="zu-sc-gutter">' + gutter +
      '</span><span class="zu-sc-grid">' + grid + '</span>' +
      '<span class="zu-sv-bars">' + cols + "</span>" + card + "</div></div></div>";
  }
  function spdLegendHTML(an) {
    var cur = an.overall ? tpsBand(an.overall.v) : null;
    var out = '<div class="zu-sv-legend"><span class="zu-sv-legend-t" title="' +
      spdEsc(SPD_L("按原始速度值分档（含下限不含上限）", "Bands by raw speed (lower bound inclusive)")) + '">' +
      spdEsc(SPD_L("档位说明", "Speed bands")) + " ⓘ</span><span class=\"zu-sv-legend-items\">";
    for (var i = TPS_BANDS.length - 1; i >= 0; i--) {
      var b = TPS_BANDS[i], isCur = cur && cur.cls === b.cls;
      out += '<span class="zu-sv-li' + (isCur ? " cur" : "") + '"><i class="' + b.cls + ' zu-legend-dot dot-c"></i><b class="' +
        b.cls + '">' + (b.lo === 0 ? "&lt;" + TPS_BANDS[TPS_BANDS.length - 2].lo : b.hi ? b.lo + "–" + b.hi : "✦ ≥" + b.lo) + "</b></span>";
    }
    return out + "</span></div>";
  }
  /* 纯函数桥：三处 speedTipRebuild 调用共用。无统一轮表返回 null（旧布局逐字回退），
   * 有则把实例闭包状态烘进重建函数——Tab 切换/hover 改闭包后重调即整卡刷新，
   * 不引用任何实例内符号，VM 源码切片夹具也能直接跑（测试纪律）。 */
  function spdRebuildOr(h, sel, hover, liveOrSess, o, paneSess) {
    if (!h || !h.turns || typeof h.turns.length !== "number" || !h.turns.length) {
      /* v261：null 原因取证（typeof FATAL 守卫，VM 切片夹具无 FATAL 不炸）。 */
      try { if (typeof FATAL !== "undefined" && FATAL) FATAL.spdNull =
        { t: Date.now(), hType: typeof h, hasTurns: !!(h && h.turns),
          len: h && h.turns ? h.turns.length : -1 }; } catch (_) { }
      return null;
    }
    var sess = paneSess || null;
    var live = liveOrSess || null;
    /* 闭包是 IIFE 顶层函数，读不到 spawnInstance 内的 speedChartHover/speedSel。
     * 由调用方在每次重建时显式传入当前实例值（curHover/curSel）；缺省回退到生成时
     * 快照，VM 切片夹具无实例状态时仍可跑。sel 是同一可变对象（会话切换原地改属性）。 */
    return function (curHover, curSel) {
      var cur = curSel || sel;
      var opts = { speedHistory: h,
        sel: { range: cur.range, period: cur.period, dim: cur.dim,
          sid: (sess && sess.sid) || "", remote: !!(sess && (sess.workspace_identity || sess.remote)) },
        live: live, segsHover: (typeof curHover === "number" ? curHover : hover),
        fmtTok: o.fmtTok, fmtCnt: o.fmtCnt, fmtMoney: o.fmtMoney };
      return "\x01" + speedCardV2HTML(opts);
    };
  }
  /* V2 整卡：顶部时间胶囊 → 双 Tab → 左统计卡 + 右动态图 → 单行十档对照。到此结束。 */
  function speedCardV2HTML(o) {
    var an = spdAnalyze(o.speedHistory, o.sel || {});
    if (!an) return "";
    return '<div class="zu-stat-tip zu-stat-tip--speed zu-sv-root">' +
      '<style>.zusage-tip-root:has(.zu-sv-root),.zusage-tps-tip:has(.zu-sv-root){max-width:min(960px,calc(100vw - 24px))!important}</style>' +
      spdHeadHTML(an) + spdFiltersHTML(an, o.sel || {}) +
      '<div class="zu-speed-body">' + spdLeftHTML(an, o.live) + spdChartHTML(an, o.segsHover, o) + "</div>" +
      spdLegendHTML(an) + "</div>";
  }
  /* SPD_V2_BLOCK_END */
  /* 思考态动效图标（用户提供的设计稿）：呼吸脑轮廓 + 流动信号 + 脉冲节点，纯 CSS
   * 动画内嵌在 SVG 里（样式随节点走，不依赖外部样式表，宿主清 head 也不受影响）。
   * 类名一律 zu-tk-* 前缀，防与宿主/插件其它样式互相污染；prefers-reduced-motion
   * 时停播（动画 none，信号线半透明保持可读）。 */
  function zuIcoThinking() {
    return '<svg class="ico zu-think" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">' +
      '<style>' +
      '.zu-tk-brain{animation:zuTkBreathe 2.4s ease-in-out infinite}' +
      '.zu-tk-signal{stroke-dasharray:3 18;animation:zuTkFlow 2.4s linear infinite}' +
      '.zu-tk-node{transform-box:fill-box;transform-origin:center;animation:zuTkPulse 2.4s ease-in-out infinite}' +
      '.zu-tk-n2{animation-delay:-1.6s}.zu-tk-n3{animation-delay:-.8s}' +
      '@keyframes zuTkBreathe{0%,100%{opacity:.65}50%{opacity:1}}' +
      '@keyframes zuTkFlow{from{stroke-dashoffset:21}to{stroke-dashoffset:0}}' +
      '@keyframes zuTkPulse{0%,60%,100%{opacity:.35;transform:scale(.8)}25%{opacity:1;transform:scale(1.2)}}' +
      '@media(prefers-reduced-motion:reduce){.zu-tk-brain,.zu-tk-signal,.zu-tk-node{animation:none}.zu-tk-signal{opacity:.7}}' +
      '</style>' +
      '<g stroke-linecap="round" stroke-linejoin="round">' +
      '<g class="zu-tk-brain" stroke="currentColor" stroke-width="1.75">' +
      '<path d="M12 5.3C12 2.2 7.5 2 6.8 5.2C4.2 4.8 2.7 7.3 3.6 9.5C1.5 11 1.6 14.1 3.8 15.4C3.1 18 5 20 7.2 19.5C8.2 22 12 21.2 12 18.5V5.3Z"/>' +
      '<path d="M12 5.3C12 2.2 16.5 2 17.2 5.2C19.8 4.8 21.3 7.3 20.4 9.5C22.5 11 22.4 14.1 20.2 15.4C20.9 18 19 20 16.8 19.5C15.8 22 12 21.2 12 18.5"/>' +
      '</g>' +
      '<g stroke="currentColor" stroke-width="1.2" opacity=".45">' +
      '<path d="M7 7.5V10L9 12V16.5M17 7.5V10L15 12V16.5M5.5 14H7L9 16.5M18.5 14H17L15 16.5"/>' +
      '</g>' +
      '<g stroke="currentColor" stroke-width="1.4">' +
      '<path class="zu-tk-signal" d="M7 7.5V10L9 12V16.5"/>' +
      '<path class="zu-tk-signal" style="animation-delay:-1.2s" d="M15 16.5V12L17 10V7.5"/>' +
      '</g>' +
      '</g>' +
      '<g fill="currentColor">' +
      '<circle class="zu-tk-node" cx="7" cy="7.5" r="1.15"/>' +
      '<circle class="zu-tk-node zu-tk-n2" cx="17" cy="7.5" r="1.15"/>' +
      '<circle class="zu-tk-node zu-tk-n3" cx="9" cy="16.5" r="1.15"/>' +
      '<circle class="zu-tk-node" cx="15" cy="16.5" r="1.15"/>' +
      '</g>' +
      '</svg>';
  }
  /* v75：数据库富文本覆盖层。桥接数据只有 outputTokens/modelMs 等有限字段，拼不出
   * 模型时代那行（首字/分段/峰值/累计/采样时刻）——这些只在 usage 库里。所以完成态
   * 历史行先用桥接简化文案占位，同时按 session 向主进程要一次纯文本统计行；拿到后
   * 覆盖占位（见 zuRequestTurnText / window.__zusageDeliverTurnText）。
   * 查询刻意不带显式 turn-id：数据库 turn_id（turn_<uuid>）和渲染器投影的
   * turnId/productTurnId（msg_<uuid>，DOM data-turn-id 同源）是两套互不相通的标识，
   * 前端查不到后者对应的数据库主键。改用 token_rate.py 原本给 Hook 用的 --current
   * 时间戳推断（按 session 记录的"提问时刻"反查最新一轮），这正是模型以前实际在跑
   * 的同一条查询。缓存按实例+可信身份+DOM tid 隔离，响应按请求代际关联；辅助对话
   * 与主分栏同规则（显式本地 scope + 活跃轮限定），远端/身份未知不查不收。 */
  var richTextCache = {}, richTextAttempts = {}, richTextRequestTids = {};
  var richTextUnitEpoch = 0, richTextRequestEpoch = 0, richTextOwners = new WeakMap(), richTextOwnerSeq = 0;
  function zuRichIdentity(owner) {
    if (!owner || !owner.getSid || !owner.getScope) return "";
    var sideChat = String(owner.pid).indexOf("selection-side-chat:") === 0;
    var sid = owner.getSid(), scope = owner.getScope();
    if (!sid) return "";
    if (scope) {
      if (scope.sid !== sid || scope.identity || scope.remoteSessionId) return "";
      /* v175：辅助对话与主分栏同规则——仅显式本地 scope 查本地 DB 富文本（远端/未知拒绝）。
       * 轮次对应由 isCurrentTurn（只追活跃轮）+ token_rate --current 的 promptTs 守卫承担：
       * 辅助会话的 prompt hook 以 child sid 记录提问时刻（多轮实机实证）。 */
      return JSON.stringify([sid, scope.identity, scope.workspacePath, scope.remoteSessionId]);
    }
    if (sideChat) return "";   // 侧聊无 scope 时不走无桥回退：身份不可证即不查
    /* 与 sessionFor 的无桥本地回退同门控：必须明确无远端证据，且泵绑定非远端。 */
    var data = state.data, bindings = data && data.scope_bindings || {};
    var binding = Object.prototype.hasOwnProperty.call(bindings, owner.pid) ? bindings[owner.pid] :
      (owner.pid === "auto" && Object.prototype.hasOwnProperty.call(bindings, sid) ? bindings[sid] : "");
    var current = window.__zusagePaneScopes && window.__zusagePaneScopes[owner.pid];
    if (!data || data.remote_evidence !== false || binding ||
        (current && (current.sid !== sid || current.identity || current.remoteSessionId))) return "";
    return JSON.stringify([sid, "local-no-bridge"]);
  }
  function zuRichKey(owner, tid) {
    var identity = zuRichIdentity(owner);
    if (!identity) return "";
    if (!richTextOwners.has(owner)) richTextOwners.set(owner, ++richTextOwnerSeq);
    return JSON.stringify([richTextOwners.get(owner), identity, tid]);
  }
  var RICH_TEXT_MAX_ATTEMPTS = 24;   // 0.5s 一 tick × 24 ≈ 12s 窗口等数据库追上（v88 扫描提速后按时间等价放大），之后永久用简化文案兜底
  function zuResetRichText() {
    richTextCache = {};
    richTextAttempts = {};
    richTextRequestTids = {};
    richTextWants = {};
  }
  /* 每个 scan tick 对「已完成 + 有输出 + 尚无富文本 + 未超重试上限」的 turn 收集补发候选；
   * 循环结束后由 zuFlushRichTextWants 统一发起。同 SID 只追最新一个未缓存轮：--current
   * 语义本就只返回该会话最新一轮，给更早的轮发请求只会拿到错轮文本（保持占位）。
   * 活跃目标变更（更新的轮完成）才换 epoch；同目标跨扫描重试复用同一 epoch——
   * 否则每个扫描周期都换代号，跨周期到达的回复永远被拒、attempts 耗尽后永久占位（活性缺陷）。
   * v177 注：wants/tids 按 SID 单槽是有意权衡——同一会话开两个视图（如主分栏+侧聊双开
   * 同 SID）时每拍互相覆盖收集目标，flush 只服务最后写入者，另一方轮次统计行停在简化
   * 占位（overlay-sidechat-turn 测试锁定该契约）。按实例键拆分可让双方各自补发（查询
   * 返回同一轮文本），代价是旁路查询次数随实例数翻倍，出现真实需求再改。 */
  var richTextWants = {};
  function zuRequestTurnText(owner, tid, stats) {
    var key = zuRichKey(owner, tid);
    if (!tid || !key || richTextCache[key] || (richTextAttempts[key] || 0) >= RICH_TEXT_MAX_ATTEMPTS) return;
    var sid = stats && typeof stats.sessionId === "string" ? stats.sessionId : "";
    if (!sid || owner.getSid() !== sid) return;
    richTextWants[sid] = { owner: owner, tid: tid, key: key };
  }
  function zuFlushRichTextWants() {
    for (var sid in richTextWants) {
      var w = richTextWants[sid];
      if (richTextCache[w.key] || instances.indexOf(w.owner) < 0) continue;
      /* 只追当前活跃轮：--current 只返回该会话最新一轮，给历史轮发请求会缓存错轮文本
       * （历史轮保持占位，与 v75 起的实际生效行为一致）。 */
      if (!w.owner.isCurrentTurn || !w.owner.isCurrentTurn(w.tid)) continue;
      var pending = richTextRequestTids[sid];
      if (!pending || pending.key !== w.key || pending.unit !== richTextUnitEpoch) {
        pending = { key: w.key, tid: w.tid, owner: w.owner, unit: richTextUnitEpoch, epoch: MY_GEN + ":" + (++richTextRequestEpoch), legacy: !pending && richTextUnitEpoch === 0 };
        richTextRequestTids[sid] = pending;
      }
      /* cn：万/亿开关当前值；为 0 时主进程给 token_rate.py 加 --no-cn-units */
      var req = { action: "turn-text", sid: sid, cn: cnUnits() ? 1 : 0, forceKmb: !!state.forceKmb, unitEpoch: pending.epoch };
      if (window.__zusagePluginRequests) window.__zusagePluginRequests.push(req);
      else window.__zusagePluginRequests = [req];
      capPut(richTextAttempts, w.key, (richTextAttempts[w.key] || 0) + 1, 256);
    }
    richTextWants = {};
  }
  /* 主进程回推：非空 = 富文本到位，写缓存并立即重扫（不等下一个 0.5s tick）；空 = 库里还没
   * 追到这一轮（或没有有效的提问时刻可推断），什么都不做——重试由 scanDeterministicLines
   * 的定时扫描自然驱动，这里绝不自建重试队列（否则两个驱动源叠加会绕开 attempts 上限）。 */
  window.__zusageDeliverTurnText = function (sid, text, unitEpoch) {
    if (stale() || typeof sid !== "string") return;
    var pending = richTextRequestTids[sid];
    if (!pending || pending.unit !== richTextUnitEpoch || instances.indexOf(pending.owner) < 0 ||
        pending.owner.getSid() !== sid || zuRichKey(pending.owner, pending.tid) !== pending.key ||
        (unitEpoch == null ? !pending.legacy : unitEpoch !== pending.epoch)) return;
    var key = pending.key;
    if (richTextCache[key] || typeof text !== "string" || !text) return;
    capPut(richTextCache, key, text, 256);
    delete richTextAttempts[key];
    scanDeterministicLines();
  };
  /* ---------- 确定性历史行（v71）：完成的 turn 在消息流末尾插统计行 ----------
   * 数据来自 tracker（renderer store 投影），不再要求模型自跑统计脚本（hook 已去指令）。
   * 虚拟列表回收重挂后由扫描重建；旧消息（tracker 无记录）不补造；
   * 同容器已有模型历史统计行（isRateLine）则跳过，避免双行。 */
  var ZU_DET_FONT_SIZE = "0.8125rem";   // v78：宿主正文号偏大，用户要求缩小（13px）
  var detTimer = 0;
  /* v79：统计行在 turn 容器内的落点——hover 工具条之前、data-state="closed" 弹出层
   * 之后（工具条类名 opacity-0 … group-hover/assistant-turn:opacity-100，Tailwind
   * 类名含 : / [ ] 特殊字符，querySelector 转义易碎 → 按子节点 className 子串匹配）。
   * v82：新开会话的 turn 容器里工具条不在直接子层，嵌在 group/assistant-turn
   * flex w-full flex-col gap-5 → flex flex-col gap-5 内容列末尾——直接子层找不到时
   * 深度找工具条，insertBefore 落到锚点的父容器（即内容列内、工具条之上）。
   * 都找不到（宿主改版）回退 appendChild（旧行为，容器末尾）。 */
  function zuDetAnchor(box) {
    try {
      var kids = box.children, i, cls;
      for (i = kids.length - 1; i >= 0; i--) {
        cls = String(kids[i].className || "");
        if (cls.indexOf("group-hover/assistant-turn") >= 0 && cls.indexOf("opacity-0") >= 0)
          return kids[i];
      }
      var deep = box.querySelectorAll("div");
      for (var j = 0; j < deep.length; j++) {
        cls = String(deep[j].className || "");
        if (cls.indexOf("group-hover/assistant-turn") >= 0 && cls.indexOf("opacity-0") >= 0)
          return deep[j];
      }
      for (i = kids.length - 1; i >= 0; i--) {
        if (kids[i].getAttribute && kids[i].getAttribute("data-state") === "closed")
          return kids[i].nextSibling;   // null = 已到末尾，insertBefore(node, null) 即 append
      }
    } catch (e) { }
    return null;
  }
  function zuDetPlace(box, node) {
    try {
      var anchor = zuDetAnchor(box);
      if (anchor && anchor === node.nextSibling) return;   // 已在位（React 重排兜底快速路径）
      if (anchor) { anchor.parentElement.insertBefore(node, anchor); return; }   // v82：深度锚点挂锚的父容器
      if (node.parentElement !== box) box.appendChild(node);
    } catch (e) { FATAL.detErr = String((e && e.stack) || e); }
  }
  /* v258：桥缺席（表外客户端版本）时的辅助对话识别兜底：沿 React fiber 找宿主
   * SessionPane 组件帧的 tabId props（JSX 属性名不被压缩）。只读、限深 24 层、撞更外层
   * 会话/分栏根止步；返回宿主 tabId 或 ""（失败/歧义一律空串，fail-closed）。sidechat
   * 切片测试（richTextCache→zuDiagStats）覆盖本函数；coordinator 里的同文副本因
   * port-patches 切片与本区间不相交而无法共享，两处须同步改。 */
  function fiberSideIdOf(el) {
    try {
      var keys = Object.keys(el), fk = "";
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) { fk = keys[i]; break; }
      }
      if (!fk) return "";
      var fiber = el[fk], hit = "", depth = 0;
      while (fiber && depth++ < 24) {
        var node = fiber.stateNode;
        if (node && node !== el && node.getAttribute &&
            (node.hasAttribute("data-session-id") || node.hasAttribute("data-pane-id"))) break;
        var p = fiber.memoizedProps || fiber.pendingProps;
        if (p && typeof p.tabId === "string" && p.tabId.indexOf("selection-side-chat:") === 0) {
          if (hit && hit !== p.tabId) return "";
          hit = p.tabId;
        }
        fiber = fiber.return;
      }
      return hit;
    } catch (e) { return ""; }
  }
  /* 只接受唯一且最内层的会话根；根缺失或同根歧义时不借其他实例的数据。 */
  function detOwnerOf(box) {
    var owner = null, best = null;
    for (var i = 0; i < instances.length; i++) {
      var root = instances[i].detRoot && instances[i].detRoot();
      if (!root || !root.contains || !root.contains(box)) continue;
      if (!best || (best !== root && best.contains(root))) { owner = instances[i]; best = root; }
      else if (root === best || !root.contains(best)) return null;
    }
    /* 主根可能包住尚未挂载实例的侧聊；识别到侧聊边界时只能由对应侧聊实例认领。 */
    for (var p = box; p && p !== document.body; p = p.parentElement) {
      if (!p.getAttribute) continue;
      var testid = String(p.getAttribute("data-testid") || "");
      var side = testid.indexOf("v4-session-pane-selection-side-chat:") === 0 ? testid.slice("v4-session-pane-".length) : "";
      var bridgePid = String(p.getAttribute("data-zusage-pane-id") || "");
      if (!side && bridgePid.indexOf("selection-side-chat:") === 0 && p.getAttribute("data-zusage-scope-version") === "1") side = bridgePid;
      if (!side && p.getAttribute("data-zusage-scope-version") !== "1" &&
          p.hasAttribute && p.hasAttribute("data-session-id")) side = fiberSideIdOf(p);   // v258：宿主 testid 也缺失的表外版本兜底
      if (side) return owner && owner.pid === side && best === p ? owner : null;
    }
    return owner;
  }
  function detSeenKey(box, tid) {   // v174：同 owner 内按 tid 去重（嵌套容器），跨 owner 各自独立
    var owner = detOwnerOf(box);
    return owner ? owner.pid + "|" + tid : null;
  }
  function detStatsFor(box, tid) {
    var owner = detOwnerOf(box);
    return owner ? owner.statsFor(tid) : null;
  }
  /* 节点只保存不透明令牌，不暴露 SID、工作区或远端身份。tracker 换代不改变令牌。 */
  var detOwnerTokens = new WeakMap();
  function detOwnerToken(owner) {
    if (!owner || !owner.getSid || !owner.getScope) return null;
    var sid = owner.getSid(), scope = owner.getScope();
    if (!sid || (scope && scope.sid !== sid)) return null;
    var side = String(owner.pid).indexOf("selection-side-chat:") === 0;
    if (side && (!scope || scope.identity !== "" || scope.remoteSessionId !== "")) return null;
    var identity = scope ? JSON.stringify([sid, scope.identity, scope.workspacePath, scope.remoteSessionId]) : JSON.stringify([sid, "no-pane-scope"]);
    var entry = detOwnerTokens.get(owner);
    if (!entry || entry.identity !== identity) {
      entry = { identity: identity, token: {} };
      detOwnerTokens.set(owner, entry);
    }
    return entry.token;
  }
  function scanDeterministicLines() {
    if (stale()) return;
    try {
      if (!state.rateLine || !TURN_STATS) {   // 开关关闭：撤下自己插的行（模型历史行不动）
        document.querySelectorAll("[data-zusage-deterministic]").forEach(function (el) { el.remove(); });
        return;
      }
      /* 两种选择器可能同时命中同一个 turn（外层 [data-v4-turn-unit] 包着内层
       * section，二者带同一个 data-turn-id）：按 owner+tid 去重（v174：辅助对话与
       * 主分栏并存时不同会话可能同名 tid，纯 tid 去重会吞掉第二个视图的行），
       * section 更具体，优先用它当容器，避免同一轮被当成两个独立容器各插一条。 */
      var boxes = [], seen = {};
      document.querySelectorAll("section[data-turn-id]").forEach(function (el) {
        var t = el.getAttribute("data-turn-id");
        var key = t && detSeenKey(el, t);
        if (t && (!key || !seen[key])) { if (key) seen[key] = 1; boxes.push(el); }
      });
      document.querySelectorAll("[data-v4-turn-unit][data-turn-id]").forEach(function (el) {
        var t = el.getAttribute("data-turn-id");
        var key = t && detSeenKey(el, t);
        if (t && (!key || !seen[key])) { if (key) seen[key] = 1; boxes.push(el); }
      });
      /* v86 诊断（≥10s 一次写 __zusageDiag.det，主进程泵取回写 diag-<n>.json）：每轮容器的行类型
       * （rich/ph/na/keep/model/none）与 tracker 视图、各 pane 的桥接快照窗口——排"历史轮不可用"类问题用 */
      var wantDiag = Date.now() - (scanDeterministicLines.diagAt || 0) > 10000, diagTurns = wantDiag ? [] : null;
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        var tid = box.getAttribute && box.getAttribute("data-turn-id");
        if (!tid) continue;
        var owner = detOwnerOf(box), ownerToken = detOwnerToken(owner);
        var mine = null;
        try { mine = box.querySelector("[data-zusage-deterministic]"); } catch (e) { }
        if (mine && (!ownerToken || mine.__zuDetOwner !== ownerToken)) { mine.remove(); mine = null; }
        if (!ownerToken) continue;
        var richKey = zuRichKey(owner, tid);
        var rec = diagTurns ? { tid: tid.slice(-8) } : null;
        if (rec) diagTurns.push(rec);
          if (mine) {
            /* 已插过：重挂/数据演进后从 tracker 重建文本；观测过但记录已清（换代）、
             * 或完成但确实零输出（无意义数字，如"耗时 939.0s"配"输出 0 token"）则明示不可用 */
            var again = detStatsFor(box, tid);   // v174：按实例归属取数，不跨实例首命中
          var againOk = !!again && again.complete && zuHasMeaningfulOutput(again);
          if (!againOk && again && again.isCompact) {
            /* v230 压缩轮（轮内带 compact 类 timelineMarker）：无正文的辅助轮，消耗已计入
             * 今日/会话累计，宿主「上下文已压缩」提示已承载语义——旧版误插的「本轮统计不可用」
             * 撤下，不再误导（marker 未来带输出数字时 againOk 成立，仍照常显示）。
             * tracker 无记录时走下方 v86 保留分支。 */
            mine.remove();
            if (rec) { rec.line = "compact"; rec.st = zuDiagStats(again); }
            continue;
          }
          if (!againOk && !(again && again.observedLive)) {
            /* v86：tracker 无记录（快照窗口滑出/store 换代/热更新换 tracker）或重绑后一步到位捞到的
             * 历史存量轮缺 outputTokens（缺字段 ≠ 零输出）——都不据此改判"不可用"：已完成轮的数字不会
             * 过时，保留已有占位/富文本；此前误插的"不可用"行直接撤下。仅亲历过的真实零输出轮仍明示 */
            var keptLine = mine.querySelector("p") || mine;
            if (richTextCache[richKey]) {
              if ((keptLine.textContent || "") !== richTextCache[richKey]) keptLine.textContent = richTextCache[richKey];
              if (!keptLine.style.fontSize) keptLine.style.fontSize = ZU_DET_FONT_SIZE;
              zuDetPlace(box, mine);
            } else if (zuIsUnavailableText(keptLine.textContent)) mine.remove();
            else zuDetPlace(box, mine);
            if (rec) { rec.line = richTextCache[richKey] ? "rich" : "keep"; rec.st = zuDiagStats(again); }
            continue;
          }
          var againText = againOk ? zuFinalText(again) : zuUnavailableText();
          if (againOk) zuRequestTurnText(owner, tid, again);   // 仍缺富文本就补发（限流见函数内）
          var text = richTextCache[richKey] || againText;
          var line = mine.querySelector("p") || mine;
          if ((line.textContent || "") !== text) line.textContent = text;
          if (!line.style.fontSize) line.style.fontSize = ZU_DET_FONT_SIZE;   // 旧代节点补样式（热更间隙）
          zuDetPlace(box, mine);   // React 重排后兜住用户指定位置（工具条之前）
          if (rec) { rec.line = richTextCache[richKey] ? "rich" : (againOk ? "ph" : "na"); rec.st = zuDiagStats(again); }
          continue;
        }
        var hasModel = false;
        try {
          box.querySelectorAll("blockquote p, blockquote, p").forEach(function (el) {
            if (!hasModel && isRateLine(el)) hasModel = true;
          });
        } catch (e) { }
        if (hasModel) { if (rec) rec.line = "model"; continue; }   // 模型历史统计行在位：不叠双行
        var stats = detStatsFor(box, tid);   // v174：按实例归属取数，不跨实例首命中
        if (rec) { rec.line = "none"; rec.st = zuDiagStats(stats); }
        if (!stats || !stats.complete) continue;   // 未完成 / 旧消息（tracker 无记录）不插
        var statsOk = zuHasMeaningfulOutput(stats);
        if (!statsOk && !stats.observedLive && !richTextCache[richKey]) continue;   // v86：历史零值或缺字段不判失败；已缓存的完整统计仍可重建
        if (!statsOk && stats.isCompact && !richTextCache[richKey]) continue;   // v230：压缩轮零输出不插「不可用」行（宿主压缩提示已承载语义；rec.line 已在上面记 none）
        var quote = document.createElement("blockquote");
        quote.__zuDetOwner = ownerToken;
        quote.dataset.zusageDeterministic = "1";
        var p = document.createElement("p");
        p.dataset.zusageDeterministic = "1";
        /* 样式基本交还宿主默认（模型时代贴的 Markdown 引用块就是这套渲染：彩色 ⚡、
         * 正文亮度、引用线）；唯一例外字号（v78）：用户反馈宿主正文号太大，内联缩到
         * 0.8125rem（13px）。必须内联——本节点长在宿主消息流 prose 容器内，bar 内部
         * 样式表够不着，挂 head 的外来样式又会被 React 清掉（历史根因）。 */
        p.style.fontSize = ZU_DET_FONT_SIZE;
        if (statsOk) zuRequestTurnText(owner, tid, stats);   // 先占位，向主进程要这轮的数据库富文本
        p.textContent = richTextCache[richKey] || (statsOk ? zuFinalText(stats) : zuUnavailableText());
        if (rec) rec.line = richTextCache[richKey] ? "rich" : (statsOk ? "ph" : "na");
        quote.appendChild(p);
        zuDetPlace(box, quote);
      }
      zuFlushRichTextWants();   // v174：收集完毕统一发起（同 SID 只追最新未缓存轮）
      if (wantDiag) {
        scanDeterministicLines.diagAt = Date.now();
        FATAL.det = {
          time: new Date().toISOString(), boxes: boxes.length, rich: Object.keys(richTextCache).length,
          bridge: instances.map(function (inst) { return inst.bridgeInfo ? inst.bridgeInfo() : null; }),
          turns: diagTurns.slice(0, 40),
        };
      }
    } catch (e) { FATAL.detErr = String((e && e.stack) || e); }
  }
  function zuDiagStats(s) {
    return s ? { c: s.complete ? 1 : 0, live: s.observedLive ? 1 : 0, out: s.outputTokens, st: s.state,
      sa: s.startedAt, ea: s.endedAt, mm: s.modelMs, dm: s.durationMs,
      ic: s.isCompact ? 1 : undefined,   // v230：压缩轮标记（timelineMarker type=compact）
      ks: s.kinds ? s.kinds.join(",") : undefined,   // v230：轮内行 kind 集合（排"压缩轮为何不可用"类问题）
      tmr: s.tmr && s.tmr.length ? s.tmr : undefined } : null;   // v230：timelineMarker 内容（区分压缩/模型切换）
  }
  function cleanupDeterministic() {
    clearInterval(detTimer);
    zuResetRichText();
    try {
      document.querySelectorAll("[data-zusage-deterministic],[data-zusage-loading-status]").forEach(function (el) { el.remove(); });
    } catch (e) { }
  }
  /* ---------- 工具动词表（v76 引入，v78 起仅悬浮条合并 chip 使用）：zuBarSpeedView
   * 在工具执行期显示"正在读取 · 1.2s"同款状态词，数据源为桥接 tracker 的 runningTool
   * （本轮最后一个活动行=进行中的工具调用，宿主从 tool_input_start 起算"进行中"）。
   * v76 的消息流 loading 插槽插入（[data-zusage-loading-status]）已删，见 zuToolVerb 下方注。 */
  var ZU_TOOL_VERBS = {
    Read: ["读取中", "Reading"],
    Write: ["写入中", "Writing"], Edit: ["编辑中", "Editing"], ApplyPatch: ["编辑中", "Editing"],
    Bash: ["执行中", "Executing"],
    Grep: ["搜索中", "Searching"], Glob: ["搜索中", "Searching"],
    WebSearch: ["搜索中", "Searching"], web_search: ["搜索中", "Searching"],
    WebFetch: ["获取网页中", "Fetching page"],
    TodoWrite: ["更新待办中", "Updating todos"], TodoRead: ["读取待办中", "Reading todos"],
    Skill: ["运行技能中", "Running skill"],
    ReadSessionContext: ["读取上下文中", "Reading context"],
    Agent: ["子代理运行中", "Running agent"], Task: ["子代理运行中", "Running agent"],
    SendMessage: ["发送消息中", "Sending message"],
    TaskOutput: ["获取任务输出中", "Fetching task output"],
    TaskStop: ["停止任务中", "Stopping task"],
    CreateWorkflow: ["编写工作流中", "Writing workflow"],
  };
  function zuToolVerb(name) {
    if (name && ZU_TOOL_VERBS[name]) { var pair = ZU_TOOL_VERBS[name]; return L(pair[0], pair[1]); }
    if (name && name.indexOf("mcp__computer-use__") === 0) return L("正在操作电脑", "Operating computer");
    if (name && name.indexOf("mcp__") === 0)
      return L("正在调用 " + name.slice(5).replace(/__/g, " · "), "Calling " + name.slice(5).replace(/__/g, " · "));
    if (name && name.indexOf("js") === 0) return L("正在执行代码", "Executing code");
    return name ? L("执行中 " + name, "Executing " + name) : L("执行中", "Executing");
  }
  /* v158：Skill 工具从输入串提取技能显示名（宿主 inputText 是 JSON，name 字段为技能
   * 请求名）——状态词显示「技能名·执行中」；解析失败/超限返回空回退「运行技能中」。
   * 名字来自宿主数据，渲染前经 ttEsc（chip innerHTML 与 aria 双 sink）。 */
  function zuSkillBaseName(inputText) {
    if (!inputText) return "";
    var name = "";
    try { var parsed = JSON.parse(inputText); if (parsed && typeof parsed.name === "string") name = parsed.name; } catch (e) { }
    if (!name) { var m = /"name"\s*:\s*"([^"]{1,80})"/.exec(inputText); if (m) name = m[1]; }
    name = String(name).trim();
    if (!name || /[\x00-\x1f]/.test(name)) return "";
    return name;
  }
  function zuSkillName(inputText) {
    var name = zuSkillBaseName(inputText);
    if (!name) return "";
    if (name.length > 24) name = name.slice(0, 24) + "…";
    return name;
  }
  /* v78：消息流 loading 状态词（v76 的 [data-zusage-loading-status] 插槽插入）已删——
   * 悬浮条合并 chip 在工具执行期仍显示同款动词+耗时（zuBarSpeedView），消息流内不再插节点。
   * 清理选择器保留（根清理 + dispose）：热更/重载后把旧版本可能残留的 span 清干净。 */
  function sharedTick() {
    if (stale()) return;
    scanDeterministicLines();
  }
  detTimer = setInterval(sharedTick, 500);   // v88：2s→0.5s，与速率行扫描/心跳同节奏
  sharedTick();

  var mpModalDispose = null;   // v128 模型拉取弹窗清理回调（openMpModal 注册，disposeOverlay 调用）
  var mpModalThemeSync = null;   // v132 弹窗浅色主题同步回调（openMpShell 注册，applyTheme 调用）
  function disposeOverlay() {
    if (disposed) return;
    disposed = true;
    pluginRequestCallbacks = {};
    clearTimeout(bootTimer);
    clearInterval(coordinatorTimer);
    instances.forEach(function (inst) { inst.dispose(); });
    instances = [];
    quotaSelectionsSig = "";
    pluginRequest("quota-providers", { panes: {} });
    cleanupRateTip();
    cleanupGitTip();
    document.removeEventListener("mouseover", subTipDocOver, true);   // v176：委托悬停随 dispose 摘除
    document.removeEventListener("mouseout", subTipDocOut, true);
    hideSubTip();
    try { if (subTip.parentElement) subTip.remove(); } catch (e) { }
    if (mpModalDispose) mpModalDispose();
    cleanupDeterministic();
    if (typeof zuRotatorDisposeAll === "function") zuRotatorDisposeAll();
    window.__zusageWantSids = [];
    window.__zusageWantSid = "";
    window.__zusageGitPaths = [];   // v96：主进程下轮 tick 读到空集即停查
    if (window.__zusageDispose === disposeOverlay) {
      delete window.__zusageDispose;
      delete window.__zusageUpdate;
      delete window.__zusagePluginUpdate;
      delete window.__zusagePluginResult;
      delete window.__zusageGitState;
      delete window.__zusageDeliverTurnText;   // 旧代闭包经 stale() 自卫，但清理应完整（O8）
      delete window.__zusageSidWs;
      delete window.__zusagePaneScopes;
      window.__zusageOverlay = false;
    }
  }
  window.__zusageDispose = disposeOverlay;
  bootTimer = setTimeout(function () {
    if (stale()) return;
    try { coordinator(); } catch (e) {
      FATAL.fatal = String((e && e.stack) || e);
      var b = document.getElementById("zusage-bar");
      if (b) b.style.cssText = "position:fixed;right:16px;bottom:16px;font:12px monospace;color:#ff7a59;" +
        "background:#1a0f0d;border:1px solid #ff7a59;border-radius:6px;padding:4px 10px;z-index:2147483647";
    }
  }, 0);




  /* ==================== Status Rotator & Whale Tail & Danmaku Engine (v268) ====================
   * 移植自 dsh-status-rotator (Phase 1–4 完整实现)：
   * 1. 挂载位置支持三选一：chat（消息流 loading 行）、bar（状态条内轮播格）、both（同时开启）。
   * 2. DeepSeek 小鲸鱼摇尾巴 SVG 帧动画（wag/sway/twist/official 四种 150 帧姿态 + 6 帧轮廓桥接过渡），
   *    经浮点 RDP (eps=0.85) + Base32 VLQ 差分编码压缩至 ~75.9KB（严格 <100KB）。
   * 3. 14 个内置双语词包（1533 条短语）、自定义短语（支持 文案|权重|when:...|rarity:... 语法）、
   *    预设与星期/时段自动排程、防重复洗牌袋、打字机效果、17 个实时占位符、日夜自适应流光渐变、
   *    5 套主题预设、窗口标题轮播与完整弹幕引擎（滚动/顶部/底部、悬停暂停、点击复制、避让指针、遮罩自停）。
   * ============================================================================================== */
  var ZU_ROTATOR_LS_KEY = "zusage3.rotator";
  var ZU_ROTATOR_MEM_KEY = "zusage3.rotatorPickMemory";
  var ZU_WHALE_TAIL_DATA = {"wagKeys":"gH!DNKJMJUFSCuBSsBMSyByBKYDYdsCFeHWGOOEIFEHMhCalCCfHXNX1B1BTjBFRAhBERKRgBYeMaQKKSgBQMSEuBAeGiDsBLKfMbE5CCXGTMLSDKAaMwCAeKKMAKLD3BL5BAbCFEFQH4CDaFcJWNOPGPAPFJTR3CnBbJbF1BDHHJTNRXTxBXjBbHDRADC|qGoERKPeD2BEQMaUcYWYQSSIQAYV0BPiCAOEGIEMDINI1BapCAhBFNPZPPlBbRRNRLVFPAnBEPGHmBWsBOMIQQIOMMMGmBACD0BC!CeIGPOdMrBIxBEbGRIRSFMAeM8BC4BIKOCKLAnBDDAVFPANJjBAZONgBH8BHyBRYRKNGPDRNRNHzCdnBJrCCJJJPfbbNnBNTPVJ|kF8ELKFIHYCoBQoBKOYY!BmBMMIOAYV0BN!BAIEIGEMAGFEJI1BYlCAdJXTXXRrBZfhBLVFTAbGPGAQKSGkBGWIMIacQIUAiBJgBDCCcCuBMcEIEDGLKhBSnDaTKLMHMDaO6BGsCKKODGHCRDDF#BP7BCTOLyCVcLWNUROXAVFJJJRJnBH5BPjBDDCVAjBINAXZhBVbJdFnBTRD|mEwFLMFKDiBKkBOYaaYQgCcQQEICIDORqBPoCEMMGIDIJMnCSxBCVFTLTRRlBVpBRhBbJLLVFRCdEDmBM2BEUIgBaUGmCTuBAUEuBCKEHMdYdOtCcTQHKFaUwCEiCEGIEMDINDvBHpBR7BCNKLIFqBRGAwBXYTKLOXCXFLLLPH7BFVFzBANELAlBMPAbXhBPpBHXAdLVD|sDmGNQDeGYSgBQQaSaMoBKaKMIKMCWRqBNgCAQEGIEOFGLGxBWlCDfJRZXbN1BPlBVVVJPHTATMDOEyBACDeCOEcSUIUDaNmBNyCDCDYACCFOTWNKTMtCoBRWDeUiCEcCwBIMGCKDILD1BL3BPpBARKNkCjBYRabGJMdARJRVLlDCpBInBQTEbTlBNPADDjCCPFTA|qP8FNHXAZG9BGjBKrBWPAZPbJvBAtBIpBAPGJIHSAKGWMWWYOKqBSiBIWCUGQIMOCUTyBL6BAOEGIEIAMNGzBKjBIRETAVHTRVZPjBLZDfJfPddJRDPCD2BDaHqBAwBWWA2BbUHaFUAwBJCORchBe9BmBNOJWEgBU!BEiCGMMEGDIJD5BHlBRvBFbCHKLoBZeXadQdEPAZFL|8OyFLFRAfK9BKXIzBahBPhBJrBCxBMrBERIHGHMASQiBWWYO2BQoBEaGQIMMCYTyBL8BAKIKMCMNGzBWlCAZLZPPXNpBLpBFfJXLbZJPAJIFgBDwBNmBDSEiBQQCYJWPcN6BLkBLCCAQTmBdcvBgBPOJQDYWwCEgCGMMEGDIJAfDDAXFdHbLbFdCHOPuBhBabKPOfETAVHR|8OyFTFzBQNAlBI7BcJAjBRZHtBA3BOlBEPETMJUCMMYUUcQuBOkCKYKMKEIAUTwBNgCCSGGKCGDILGzBYrCAZHTVXTLlBLxBHhBJVJLHVVFHAJUHiBFsBNqBAgBMOIWCKDuBZSHgBFyBPCCAWFOPaferBcRSHQAgBQgCE!BIMMCMNAbDDAXFdP1BAbORiBXkBjBKPKVIdAbHT|uP!FLFPAjBM3BGzBURAbRlBNPDxBCjBI7BIVOHOAKMacaYMcK0CUQIOOCYZiCJoBAOFMEMOGGDIJMnCYjCAbHTVXXNhDZjBPXTJPOHoBFiBJuBDeIoBWOCYHmBR!BJaLEEAWHUPYbY7BiBRYFSAQM!BE8BEGIEIAKJCZDDF1BLxBCVKPsBZYTUXKROpBAfJV|wDiGLMDUIUUWiBWqDqBSQEIDYZ4BNqBHwBEIGEMAGFEJK#BgBxCCfFPJPVTdPhBLhCdfbFLKFoBACDgBACDsBCYGWMcWSGOAwBNgCASHGCDcPcXWNInBQRETKNMLUDoBIqBCwBCGKIODGJAlBL9BChBMPsBRcPOLadKTKhBAfHPLLZDTGhCAxBMLAbVdRbJdDDDrDERE|6EiFNMDYMaIKea6C2BSQEIAQFMf6BPqBL4BEKMGIDIJGpBIhBKbgBhCChBHRRVzDpCXZFLEFSAiBGyBEiBKaQegBQKICkCAuBKOACDMCAMNadcjBOzBGTGNINOHMFWI4BCsBIKGCMFGLDtBJzBEVKLKFwBHWHWLWRSVObGVDhBLNJFnBCvBLjCAtBrBfRZJhBHlCHDDXANE|yGkEPIJQAOEQIQMSsBsBmBgBWaASJQbmBb!BN6BAMGIOCMNGrBKhBUtBUdMXENAbFNPVpChCZbLRFNCHeGGE0BOoBSMIUUSeOOIEgCMiBQUGOAGEDKJOVUXMfGhCFZGRMPaDYIuBAiBIMMCMNAnBJvBEXIJMFiCEgBHYLSNSTINMdAXFJNLhBF3BX1BJJFVhBXZXRjBRtBNhBNdH|kIyDNGLQDQGeWqB6BqCIQAMNWdiBLQXyBRmCGOMEGDIJIvBU5BQbgBpBKVCLATLZlC7CPhBDNCHIAOGEE6BccSacIOMgBKMSKmBMQIcUYMMCEERWPKZKlBCjCRbCTKJIJOFSAUIoBAgBGIOCIHEJAfJpBATELIJSDiCQcAiBJeTUVMbAPFLJJnBPjBZRJzBTFFJXRfZbdVjDxB|wJoDLELKFIFOAcMqByB!CCMLUnBsBZqBT2BDSHUCOIGMAIHM5BSxBSdmBtBKTERALHVf1BPdNhBDjBEHWMYUmBaWWOWKoBOW2BcsBmBgBURSRIbGjBFvBTdJbCTKLMHODiBGYAoBCGKIKAKLAvBHZAVELGHEDWCsBSeIQACCaDaJYPQRIRCNDJJNhBTfdbTrBVHHHdPhBPVTTpC3BRLRH|2KkDVGLKJQFSCuBQ0BY2BAQPWrBwBTiBPmBN0BAMKKKAKJO#BQpBSdmBrBKRGRAZb9BR5BAfEPEFKEgBgBQMiBkBMWIwBIOYSeQ0B0BYSNMbKfAfJpBVdLTDZIRQJWAaGYAqBIKOCKLAvBHZAVGNGFKDOEyBYYIUEiBAgBLQLOPGPARFJLLRL1B1BVPfRHHHlBJZbnBpClCRLND|qLkDNAPGLKNYHgBCiBKqBU0BAQNWrByBTiBPmBN0BAMKKKAKJO#BQpBSdkBrBObCfX9BLzBAREVGPGHSQKOqBqBMQMeCiBKU!BqBcgBmBkBAEFERItBCfLvBZXJdDRGTSJYAYGYAqBCEKIKAKLAvBHZAVELKJUC4BcUIaGmBAWHaRMXFVLNbXZffbtBdFPDfJXZlBrBrBZd|uLkDTCJENMNWHSD4BKuBQoBAUNWpB0BXwBTmCAMKKKAKJIpBQxBWpBgBpBQjBAdTxBJlBAtBKbKLMKUcccOSMcCkBISKKyBeqCuCLKNEXCDDPAbJ1BbfLZAPGTSJaAWGaAqBCEKIKAKLAvBHbATENIJSAiBOiBSYIgBGkBFUJSRGPALHPrBrBLPbbbTVLPNFrBLbRZvBzBNTNL|qLkDNAPGTUPeFSAuBImBMcIcFQJQlB0BXyBRiCAKKKMAIHM5BOnBMZkB1BKXEVDRRpBLrBCzBKZMNGEakBccMQKYCgBIUQOWKiBWmCqCFGRGnBAhBLdPrBRdDVIPOLeAUIyBDOCMKIKAKLCbJzBARGRIHWCkCekBKqBAQFWNMRCPHRrBrBPTjBfxBbJJDhBHVLVTZddRZRR|gLkDRCNGLKPWLcDOCwBKmBSqBAULYboBLUTwBHiBHSAKKKMAIHGVEdQvBMZWjBQjBCnBZ7BHhBCrBKZORMMSakBkBIMIUEiBKSmCmBuCsCHGLElBCtBNlBRbJfDPEXWJeKiDIGKAKJCHAfDDH5BGVIHYCyBU6BQeAUFULKLGNARHNnCnCjBZdNVNFhBHTPbtBvBRZPP|mKmDRILKRcLoBAWEaKiBWsBAYHShB6BTwBN8BEIOGMJGTItBOlBiBhCIbDlBZzBLvBATGbKVKLMKMSyByBKWGkBIMOKqBQYOuCmCFGJEjBEjBH5BVbHbARGLILQHcCeGeAkBEGIEIAKJCHAjBJ5BCPINYDwCakBGQAkBJOJMPCHATFJNPNJ7B3BPLhBRVHRLHlBTjBzBzBNTPPJF|2JoDLETSHKNeFWAYGgBIYYqBEKCSHaZuBRoBRkCEMKGGAIFEHItBIbKbYvBKhBCNDZFNd1BLrBAVEVKXKNEAYegBaSUMcCSGMMMMGkBKcO0CkCJINElBCxBLnBNdFTCTIJILSFgBI2BAkBIKMCMNAnBJ5BEXIJKDUCyCWqBCcHYPKTAPFLJLfXvBpBlBV1BTFJHfRdNPrBlBXdNH|mJqDNGTULUJgBAkBGaOiBcsBESHgBZyBNiBN2BAOGIOCIHEJK3BOnBUpBIdCXFXHPXhBLVLjBAjBERGPORiBkBcUOOMUGaMSUKqBKiBQuC6BLKdGnBDrCRfAPENIPWFiBI0BAoBIMMCMNArBHhBDfCPILeD!BOcCCCmBDWHSLOTAVFJRRVNjBdZRfP5BRFFHbLVNRzBpBbfNH|0IuDLEVWLWHYAmBKkBQgBeoBGSDcZ4BNkBHmBFKAKEIGEMAGFEJK3BQtBQjBGbAXHXNXbjBLVJdCrBKZILYYqBcUUIOIaMOSIoBGeKWMoCwBNKXGvBAhCLdAREPILMHODiBI0BAoBGMOEIFEHAxBJzBAVCJGJKFYAgCK8BDUHSLKLGNAPFLRRtCxBZNZJxBJJLFRLVZbrBdbdNH|8H0DJETWLYFUAiBMoBSgBmBsBIaDUdmCHYFgBFKEOGEMAKLIxBKhBSpBIjBDbPhBjBnBJNRlBDpBGXMTeaeQUOOQOgBMMQGeCoBIcMkBWaMMKJIdKrBCDDdADD3BAdKNMJUAmBIuBCyBIIICKFGNDvBJvBAhBGLKF0BACC2BCmBHSHOJOPGPALLTLJfP9BjBnBN3BHJJFPVfPNxBdXXPJ","swayKeys":"wFoFIVSNcCUKkCUsBagBqBmCEeIgBOsBKKIGMDaVeFAJKZOpBMtCGRKFKAaGcE!BHKTCLLAhBLlCCbKZQPQHuCHiBLWPMNEPjBJ3BVfFpBAPFRNNXZXZNpBL1BVFKCUOgBcgBEAMOEAGIEASSGCAEMMIUAgBFQjBwCL8BJKRAJJG3BMpBY1BGjBLVVTNHJLFAtBxBRjBFT|oGiFIZMNOFWEYMCE0BUeSYYCIECKWGGiCKWIkBUqBOMOAcHMTUjBUzBKpCDLEJOAeIiBEwBLMTDHJDpBLzBAZGXIJAFKJUJ4CAWFcPQRCJlBN1BbpCNRNRhBZZjBTbJnBXHADkBOiBOQAEKIAEqBoBMUEOAiBHSLQAGFCDKJMNiBLgCJKRAJJG7BMrBe9BEfHR7B9BAFRVRnB|gHgFGZKPSJaGgBYYKCEMEQOEAciBQkBkCSWMIIICIIiBOKIEICWLULMhBUhBIvBArBHNCHGFMAUO2CLMPALLDjBLrBArBMbMLQHiBAkBGsBFaPKLCLfNDFJDDFjBVZJlBHNHRTNhBZbVLDFHADFRHDFJDDFdRFIAgBGWUkBsB2BIUCcLiBFCLYFCRkBLiBHwBJKRAJJG9BOtBiBhCENAXNXhBlBbvBLnB|yH4EERMTMHaEcYsBaSQAEQSIQESIMcGmBQqBgBaMIKEWLYTSVMfIlBApBJPAJGFMAWOqCAKLMPALLDhBLrBArBIXOPOHiBAaGwBDWNIJENdPhBbhBPfHRLLPJdNVfbTJpBfFUEiBSqBECCISWUiBEQAWHYbwBFCRkBJcHsBJKRAJJAVItBQtBkB#BENAZJTHFAFdnBTnBJhB|2HgQIpBKdUpBQXOhBAdRdLLJTFDVtBHbArBEROTSFUIQQqBaKMIEAEGEKUECOmBkBISIeYEAEGiBSIOAWNYRQVMXGpBAjBHNGFKAiBKuBCeLMTDHJAVNhCClBMbYPcAgBGaDMFMNEAKVlBVVTVLfHRJLLPpBFDHPXVjBVTTFADgBEWa4BcmBIYAcHWbwBFCXuBPgCHGRAJJ|2HgQQ5BazBKNGREDIVDhBpB7BRhBLpBAlBERKPUHUIMMwBccgBQoBuBKUKWScMMOCaPeTSPGDEjBIzBDJGFOAiBIqBCiBLMTDHJAZL#BClBIXKNQJgCAOFUPKRALbNRPXNxBLNNNhBPXXTNFDFJDRPLFAmBIaSiBiBuBIcAWJczB4CR!BHGRAJJ|uHkFGRKLcAaOCEQEiBUSUUmBiBAUGkBUaIMQCSFSRcPOfQ1BGNGHQAiBGkBCuBLMPALLAjBJ#BGvBKROLaHgBDWLQRIRALbJlBVrBDPHNPPhBRRTLRFdRDQGgBcyBWWScEOAgBFQRiBFChB6BR4BHGRAJJEjBY7BEDENEDWpBGRCXHTnBtBZrBLnB|8GwFGPIJMFSCSKeGgBOWUSe0BDsBQaEIEIKAoBVkBXUhBOnBINMDuBEUCiCLMPALLA3BHtBAXGdKRKJaLgBHSLSTIRCPXFlBP#BAPLPbTTZLjBJLHHCCYMgBOQAEKIAEoBkBKQGaDYHUvByCPwBJKRAJJATEPW1BEDGREDWrBEjBFNJHAFFApBpBAFTXRpB|kGkGERKNOHKAgBKaCeIYOciBMAUHgBAmBKaAMEMMCiBFORcXWpBUhBILGHKDeGsBA8BHKTCLLApCFVArBERUb2BTeTQVIdfDpBLhBEJETARJJJFLdZTHnBFbJCaQiBiBiBYOSQMUEOAcJapBoCPwBJKRAJJATQvBoBpCEPAbTXjBXjBlBTlB|uFmGEPILMHYAeIkBCiBKCEWMWaoBJoBAiBIiBAKEIIGODcNaNMAEfYfOrBMNKFeGsBAiCHKTCLLCxBHzBAnBGVEDELQN4BTcRUXITANlBALFnBF5BKVJbfTLbHjBDdJHCCYQemBiBqBYSSKaDmBJWlBmCLoBJKRAJJATQxBmBtCCVFPLNxBdHJPJXZVpB|gFiGEPILMHSDmBKsBEmBMCEOGGIEAUYSAaHmBAuBKeAWKIQDaNabclBUjCSPKFMAcGmBA8BHKTCLLAnCHtBEhBMVKJWL4BPaPadEVnBDzBLlCIRHfhBXNpDTCYOcqBmByBcSUIUCYFULcFCAGXsBNyBJKRAJJATOxBe#BGXATFLPP1BfnBjBXnBHZ|gF6FGVKLQHWCiBM4BKoBUOMAEUWsCDqBM4BISOEOFaNUjBenBQlCMNEJIFMAWGiBCgCHKTCLLA1BHlBAtBIVKNWN8BLsBRWTMVAHjBFzBPZD5BERHhBlBFAPNfLpBHjBNLAAcSgBiBgBwBeWYIWAcFQdgCJYJsBJKRAJJCdMvBelCEXDNNT7BnBnBnBRdHT","twist":"!H6QHFFLIxBMpBWvBInBJVrBlBFAhBhBAFTXNfDpBKXQLWAaMkCUIGKCCEOGGIEAgBqBoCEcIaMyBMKIGMDaLSVUfSxBMhCEJCJIFKAYIsBCuBLOPAJHDHDxBJtBCjBKXKLWLsCHkBLUNMNGRdH9BXxCHRLTdRRPHDFpCXZNNAAaOiBaeEAQSKEgBeOeDoBjBwCNiCJKRA|!H6QHFFJI1BKjBczBIpBJVFDNPDAPRFDVZHDFHCHTXAJFDCFFAAJDDCFFAAnBCFDDEADDENEAAHOJWAQKQESIYGCEKCAEOEDCOGCCACMKYkByBCWEEEUIEEMCCCOCACGACEIAEEKEIMAGCAAYFACCHGDITWLEACHCHGxBO1BEPEFGFIAaKmBC0BLOPALLDxBLxBCjBIVMNGAMJgCFkBNCACFOJKNERnBNRJTFAFFCDDTAHFZAJDJCAFHCDDAFFCADFAFHDHFACFNVNNNJADFCAFDCJHhBJAFFCDFFCFFNFPJJAAcKcIMEKIGAEGAEKSOAEcaGKEQEEHwBlBsCN!BJKRA|oI6QLAJJDNGdMxBMXUhBIdANFR3BhCDHAFLPAFFDCHFACFFFALDAAHDDApBIVOLUAQGAEMEOIMCSIGGKEACMIGKGEUiBoBCUEAEKCMIICCEgBKDCKEGEGQFgBZeTOjBM1BEPIDIAaEKIqBAoBLOPALLDxBN1BEhBGTKLUL0BFeLKJORGRNHLAAFHDFCAFHFNFDANJJAADNCDFLCVFHCCFFALDCFFAFDCFJFCFNVNRRLHDADDCAFFCRHpBVAcEYKOIUGCGMOOYeGMCOCCASHaJWFCFOJGNgBFANkCJIHA|qI8QNDJHDJK7BWxBWfKdALDVFAAFJJHPXdADFFCDFDCDFFAHFFAFDACFFAAFFDFfAfDFCDAJENEACHKJUAqBaOCCEGCAEGAAEKEQWKSCMGEmBCWKCESKOCIGACMKGYLcFCNWVSdIrBELKDeMuBCwBLOTDHLDtBN5BEtBINUNsBFQFIFAFECUZETLHFCCFJAADFCAFPJFCCDFFJFFCADFAADVAHDLACDHCFDCDJAHJAFDAADDCAFDACFFACDFNRbLFJJJAFFRJFFHALJAcEcKQCIEEAGUaIMIKGOCCEkBNkBLODMNKAERcNiCNK|qI8QNDJHDPM5BSnBYjBMdEHDDAZFJDALZFDCDHFFNHLNjBFVArBEVEDAFCDKFAFSASKKMUGEGSOIQCADCGGKeUAQEgBYUGIOCaJYHGLURQXIpBEFKAaO0BCuBLOTDHLDtBP9BEpBGLSPmBFUJAHECDFCAAFEADFCCGLDDECDFCAETDDNFDFDCCDFAADLFPNjBDJFPTHXCFFAHRNNJDADNFPLDCAgBCCAGCDCYEGAEECDCCAAEEIGIEMCAACECAECAAGCEEDDECAACCAAGCAACCCCICgBRsBJGDKPQTkBPgCLG|qI8QRFHPK1BUpBepBCVELAHDAALGPDHCLDDAJDDAFJfAXFACJDFAhBCADPEfCADFCFCAAFKJQDQKGOMGEMEAIMDCECDGEKEcQGMQAGGCGIICGGCMDMCGHYDAAIGIAENUTMdEDEAYEQCAKoBCuBNORDHLDrBR#BA1BSNKAcFAFDHInBbjBHACDLFNJCFFADHCHFACJHfJRJHFUAYEAFIEgBMmBAICCAODCFMEULMDIFEAIDCAKJKDMPODKLOPgCNK|qI8QRFHPKxBIZEDITkBpBJRCVDHIPGFKZAjBEDDJETDLETELDFCAExBELEHEDQAKKCOCCDCEGAICACMAUFOAQCCCQDICAAYGACIAKFADGDaEKCAEGQCDUJSXIFGCQKUIiBCsBLORAHJF1BRpBHhBGLDLJHDLFAJMHEESDCDYDAFILIFMJIFKL2BNK8CjHCRAQDA9CiH|yLyQH5BLZAFJNDXHAEDFFIFFRLFHFDCPCNNALFDDLQbCAIVAHEDAJMRAJEFENMNDFGLDDEJAHEDDHIbEAALEAANCAKNMAIEIUFCHsBPeDOFELCKGHEDSFGCEFACCDELCLQDIFAKYMIUEEODaFECCHCHGQmBGcCqBLOPAJHpDIRFHPGnBMdEFITIFCJGFUXIAACDGCCDGCCEAFGAGEINKJKAGLKFIL0BNKoDL|yL0QH5BVrBJtBrBVJNFDAFFDChBEVEDDHEAAHCFSPEDEHCAAFONYHDDCAEPEAAHINDFMVGDIPGACHEJEDAFMHOAMKEOACDACCCKAIFIAIDAAEDADMDCACJQCCDAJSHGAGHGLSDAAEFAPkBHAJNLDADOdahBKTGVAJHCNMTsBJIfIPQNGDEAeKIcMSUAiBEEAKOaEOGYAiBLOPAJHpDIRFHPItBITGDEPMLAFIHORGDEUIKAGXSAGLIN4BNKoDJ|wLqQFtBXpBNxBXHfPXXAdDDCVGFDFEAAHILGAEJcNEJMAAFgBHADCAGNEDDDCAAFEJEFEADFGNIDWXKDQTMHQAMKCOCADECUDACGJSAKDADGFMPaCCFACCFCDGFCTaAGDAAGFACEDAFIDAAIHALNLDADKbajBGPGNEbFALMLGVoBLKPEHELANMTKDGAMEMHCCEKGIKSGKQAYDEAGWqBKkBAiBLOPAHFDDALpDSNDJHDLIrBShBMLDDEHWREGAKMKAGZSAGJGN2BNKYtGDDAbGHFiBuC6F|wLqQFtBLVFDNZNpBJFnBHbNLJTXAlBEJEADDCAAFCFcVcLSNWHaDADCAGNEDADCADFEFEDGLWVIFSNKDADIFMJAFMFUDMKCIDKEAAEFkBFGLgBXeJSDACCFCFMJJNAAHGRMRENATHCNMFAFMFEFKPQbILMTICIDEDACaFCAEIAADOCGMCMFQPAAEGQWkBKeCoBLOPAHFDDALpDSNDJHDLIpBQfKJADUXEAECEOKKAEXQAEJIP4BLGwBlGRDAFPFTAFFFAARQReNQLqBHJIRGLKHMFYCQFAgC5CGFAFMNAHGDCJSRsBZCFEAAFEAHaTFXIbYACDACEJIFMRGfqDDDAFEADGU8E|wLqQFrBJTTZTtBRJrBFVHVNHJNLAFDAAFFDAlBEADDCHEAILSNIAAFKAADGDCDMDeR2BHOPCFONEJOJEJEACFGAEFGDMJGAEHKAADOFCFOLaDQOAIGKDUDCAIDAAKFCCEJQLMAETcRAALJLHGDDAENGAGXYbKHINGAIFCCCFMIKEULWNLLDFHAJIHAJRPALKdebMFAFMFYfMHGHSHQEKRGbALFAJIFAACRITEdQNMDEFAJIJQFAAEFALKLEdCDEZAPKTGHALIPERICUIISCcDMGEKYCMGKMOoBYgBIWEMEsBLOPAHFDDALpDSNDHFFRIlBOZKJSXEDGAGQIIAEJIFAJMLIN0BLGmDT|wLqQFpBJRXdVtBbJtBDbJXNTTAFFAAFDACFHNANCDAHCDDFEJURoBLCDKDoBRkCHUZMHAFCAGJMFAFEACFOJeLGHcFYRSDOCAEICKWDUAMRcCEHENQNGVSJAVMFIHCJKFAAELERMJEFIHGCOFEFUNSHFFLPJAHGDGNFPIXGFCFORGDCFCCKJIFaZIDEHOHGHEAKLIDEHAHEAGHAHGJCZJAAEFDACDADEFDLInBKFEFAACFDCEFDACHADEDAACFDAELIHADGHAJOJAAGFAAGLIPIACpCG9BYZEJIAECADIEGIKKCCCCAOEEAIEwBEAEQAQIKKSqBYiBMcEsBLOPAHFDDALpDSNDHFFRKrBKPUVADGHMFGSKGAEJIHARSLuBNKmDT|wLqQFnBJRbfVtBdJxBDhBLVLTTJTDVIZYRsBJ0BVoCFgBjBEAGJSJEHIFsBTcFaRcDOGKQAICAAUCCFGCEFAFGAGDAAENMCEFAAEpBmBDGHAAEHALMLEFEHADGLEAELCDGNGACJEAGJEFOHCFSRaDAJTJJFHGFAFCAAHQfEJEDAFECOTEAEHECCHEAgBXGDCFMJILGDKNMJAJEACFEAAHCACHEDENAPNAfQJAAEFDHEbGdMHIDAFGHALOHAPURIAC1CG5BWfEJIEODEEAGKGEEDCECACEEDiBK4BEWIIISsBckBMcEqBLOPAHFDDALpDSRFHPIpBKTcbIFEEEMKIAEJIFARQLsBNKmDT|yL0QFrBFNZhBJHVnBAJVHzBDXFjBRVVFJDAAFFNAVCDAHGNWPuBJ0BVoCFgBjBGAGJIFAFMFEFMFKHiBLADYFcPWDMEMQCKCAAWDKLOCCNKCGJEJMHCRWJCJKJACEHEFETIAEFAFEFADEdSFIJGAGLOAGLaLMDAFNHFHXEFMjBGJCAAFGDIJAFGDAFKFAFGAMNeRKNECKPECCHCCAFGDAFEAKLDFEACFEDAFKNEJARNAfQPCFEXEdMLGDEDAFGFAJGFIHAPUFCFDFGFCAC1CGHELEFAlBOfEHGAUEAIMOIOCOG!BEMEMIIGQmBgBqBMaEqBLOPAJFpDGRFHPInBKTgBdICEOIGAGHEHAPQLsBNKoDJ|wLqQFlBRVAFXXRfFRZH9BFdLFFNHAFNJFLFDALFFAdEFDDGJAFYPmBF2BVCDqCFchBGAILGASRKDADUHEFyBPaNYDKEIIEMCCEWAGRcDANUXUFILEDEPKHINGDEnBUXWLWJgBPSRZCFAPGZEDAHGPUTEJEAAFECEHSNGAAFECEHCCILGAAFCCCFQLEJEAEJKHEFDDEACDDDMJDDOZAPREPINCACFAPGHDAEFDNEfONIFGFALGDGJGNOFEFDLKzCGxBURADELCJDDEJCCWKMMIeIiCEOIOMQoBceSiBEqBLOPAJHALpDSRFHPInBKTcbIAEOMKACHGHCRQJoBNKmDT|wLqQFlBRRAHZZTfDPXJjCFbLXTHPFFAJFADHAbEFAFCAADEFADQNKFkBF4BXqCFehBGAADQRUJEFkCVkBTUAOGOYAYHICCFACCJMCCFADKFAPSDADGNKFGJEFEJGACNIAEFAACVKACFAFGLCDENGLMJGJQHqBRSFADLPNAFGJCZMhBUVDDCCAFEDADkBVCFEADDECAFGDGJMHYVAFMJCHMJCJILEJCADRJAjBQtBMJEDAHCACTIJKHAfgBRIDEvCGtBQVGFDJEZGAUGCDEEAIOEDEEMCEEuCGSIKMOmBiBiBSiBEoBLOPAJHALpDSRFHTIhBKVcZIAEMMMDELERQJoBNKmDT|wLqQFjBNNFLddPbFRVJjCFZLVRAFHLADFFAJFFAdCFCAAFCAELSLqBJ4BXmCFehBGAILEAEJMJEAQJgCVOJIDADcDKGOYCYFAAELSFMFCZeFCDGRIRSDAACtBaFEFALMHENWCGJmBRUFDDJRNAHILEjBKZWbiBVCFGAAFGADDIDDFSJUZMJCFKJQfAPLAZOvBMHEDDAEFADCDDHGDDAEHAXUFDZcNGAEHACCvCGvBSVCFEJAACTEAUECCIECAECDDEECeKiCEUIIMQoBkBkBQeEoBLOPAJHALpDSRFHTIhBKVcXICCMOMNGROJoBNKmDT|yL0QFjBFNJJFJfdRdDPFFVJ7BHRHLLLNDNDDALDADdCJEADDILSNcFEFsBRCFmCHILSVIDAFGHEAEJKFCFMDADEFQFADmBLGHEACFEAEFGAADcAMICIGGCeDAAEFGACDADKFCCCDAACDADINKNSFCHKFAXYlBaHCACJEFIJEHICCDAFOAWDYTUDAFLRNCHGJAhBKhBcfECEJWNMLAFGAADKJWZEAENMNIREHDPHAdQDAHEVEnBSTUJCAGHCNQNGDE5BEACNAVIHAAELEFDFEJADEXENGASECDGECAIGGUG8BEIESMKcGMAEmBmBACEACKKOEQAaLOPAJFpDGRFHTKlBEDENaXICCKOMAENEPQLoBLGoDJ|yL0QATJdvBvBDLFAAFJNANFHLH3BFVJLNHRATFFAXENCFCAAFEAADMLIFGACFUFQJUJCF!BHINIFDDMNEACHUTKFCFIACFMFCFiBNSNMDQCMIGUCADAAECQJUFIFKJGHQNKDGFAJMFAJMJEAEpBcRUFOEWAcFIRQHNRNGJELFPATEXUdMNiBZgBjBGLCAGNIHITCHAPVKACFACCFDJEACDDTIVMLEXWHCAIDAJKTQ1BGJAnBQAEFDhBKFEAYCCAQEAGGwBCYGGGKKMqBuBsBOgBAcLOPAJFpDGNDJHDPGVAJIPQTOLGAEMOMACNGRQHiBNKoDJ|8K6OjBhBNZDRHNJDvBDLFLLHRENANFDAXERQVgBJMLKDKJ8BLGNEDDDQNAHQPEHIDADIDUPaLONYDQKAGEGAECECULYDCDKFCDIHECEFAHMHCFKNKFKRKVWJEJKAEJGCEDADUGOCaHONMFAHJRNAFKHAPJVGnBMT0BxBCFWZDFEAAFEASjBCHAFCADNNIAEFAACFDFEDAACDDLEJEFIFDAEFDDELEAEDDFGDDDGPMCEHCAEDAACFEAEDAAELEFGJCpBCACFCJDDCCCFAJEACFAACHAFGNGFDACFANEFGCqBIEsBEMEQUEWISUUCDaaISESAWLOPAJHDfHRFAJN1CiCNDHFFRKlBYbKHEAEKOOAENENMLoBLGyCjC|!J!NRbFbDFHDlBDJDDDFALPDPGJDXALCDALENEFEADDEHiBNAFMFEHIDEFWFCDYDFDEAGLCHCAKNCJCAQTKFADMJADgBRKNYDMKGMCcNiBHGAGDAAIHEHKHEAEHEAEFAAIhBgBFCVeACDCDMEAAEIQCcHONOFATXFAAFKHANLXDfEAAFCDDDEADFEDDDGFDFGJqBrBELWZCHCADFECDFCAAFCCDFKPENALHCAEDDACDAACFARKFAACNKJCJKDEFACENMFKFCAILIPGnBEXMFGfMDuBkBEQGEEDCCACGGGEaISQSGAacIQEQAWLOPAJHDdHRtBrB1B!CRFHPOtBQVQJKSGGEAAENEPQJkBLG0B#C|oKqORPLTDJAXHHlBHJHFHFPCFGFDDGHDFCHDAAHCAAJKHKNUPCHGDAFUPADEAKHSAGNCAEPGDDDEDENEDAHCACHMJAFSPMPEACHEDEHEDUACEIEEUCAASNiBCEHCAIDACEFAFOJILUjBsBHICEFAFKCSECGOCCEQAOHMNMFATVFAAFKJFHAJNXAhBMbkBrBMbIJGVGLETRMVWAEHEAELOCCDAAEFMJIRMXELEhBgBHCLKAIDCCEMCGGEAEGKEMQAcGQSQGAKMACQOIQEmBLOPAHFDDDdHPhBhBhCyCRFHPIhBELUXMHCCEIIMICAELCRQHgBNK!BzC|sKwOXVFLFDFNAXLNPALHHLANEJIFEHDDGAWPGTINGFAFEDAFGHADIHADQAKbEJCAAFIPAHEFDDerBIRMHKAMKCGEaDQJcHGFSHIPkBJILWFCHUASOSISASFKROTXHDKNHHDJLRFfKhBQfEDEPGHDFEAUxBLMDMZ0BNKNGHADERWIGAEFEFMJIHAHEAEQIEIAQDECQEIQOKEaaEIGMCiBLOPAHFDDDdHRdZlCsCNDJHDPKjBUXOJEKSQNGPMJkBLGiCtC|qKyOJNFAJJAFJJFNAVFRNDJHATGLQLDKICUHGjBCAAHINAJDECLCFMCAFEFKnBEDAJALEADHCFCAAJCFEAAHCADDEHAFEFEXKLQACEIGASEADcHQCEHKCEDCDMDCFMAEDAAIDAAGFCFQNYJeESSSKUAOFMPMHAPVJAKLAFJHVjBbHLIIIOIAOFGCUOQUKWYCGGKEkBLOPAHFDDDdHPbZFAjCqCNDJHDLCJKhBQVQJCKKKIEAENELMLkBLGgCrC|wLiNMLZdLTFdIjBLEAJCLKGERInBDbIdEpBIJOAKKCoBVmDJaFiBGMYaIUDOFINMFARVJDnBwBJLFARVFLAZGRJDJJARMNQHDOEMMMICAKHMCUOOUMUUKSEkBLOPAJHDbJTdXlCqCRHFPMnBQTOJEKSQNGNMJgBNIoD7D|yLkNIHAJRPDLCHFDAJZVANFAErBJAAPCDGCAFCACJCZENDLATCADHGNDHGVDFEDAJIJQAIKOmBCcFSGSAOEOAWJaAKFMHEAMIIEQGEGMAQFMNMHAPVJDpBwBDFHHHDJNDAJTAVQPFHHDFFDTELQLAKMKAGKKICCGTUCUMMUMWUKQEmBLOPAHFDDDbHRPLDFHDFHFAjCoCNDJHDLCJKhBORQJEIQQACLENMJiBLGkDzGDPEXDNGVCgBJkBE6C|oK0OJLHFRTDJATEJMDOHFJNJFJALGNCACFCECAKJHJFRCHFDCbHAAFDAANGFEhBAdDHGNDJKjBGHSAACMKEMKIIQEWAYMMMcIICcNmBVUGCHSKIGOASHKLIHALRNFIJAFRTJDVIDYCIOKEAMIaYKWCeLOPAHFDDFfFNXTLFc3CDHHDJJAHIDMNARDAJXCjBFDALGpBAjBGSAYGODCEAEIGEDEEAKYEEAMHMAMPWCINSAEHE#C!ENDJHDLCJKhBORQJCISSNGHKFAJiBLG!BpC|yLmNIHAHRNbFLNFFFNFAEXFDAFGNJNHTCJDDANJJANEADDADCADDA1BCfEDAHCADFEADFGDAHGHSAACECGIGCGMICEGECKQAKEEACCADGEADKCOMCACEAEGGCGMECACQMAIGEAUPoBDAJKNGJKHCALLHCFJJYVIfJLFAJNFDCDTHLJDLFCALDADTAJFLFLRLAsCEIEeIOCMDkBKMIEKASIMMGOAOFKNMFANTNDtBsBVTAFDAJNAZEHAJSGOAAaeUSOSYEMAaLOPAHFDDFjBFFRRTL#BoCNDJHDPKjBSTOHCKSQLEPMHgBLGoD3D|yLqNINNNHAHJHARRNVCFJbALFFAHFDDHFDLnBFHADDDFpBCxBAFEADFCAAHEADDOLOAEGGACGEACEECCEGAAEMEQQISGKAMGQUAQIOQSICECAAEIIAUNoBJCNOjBKDNTRoBPINEVXNNRbALFLPNzBFDHJTJADHAA0BEAAMMcAIQaAKCCDEGYaaEAcYEMAQFKNKFDLPNF3BkBTTFJAbITGDAGMKKCAKFEEIeSSQQSGYASLOPAJHHlBTTVJHJ3BuCNDHFFRGZELQROJCKUOACNENMHgBLGoDzD|yLoNILPPFAHHJAJFRTAHFFANDDEXFDHLAHDAAFDDALFDCDDDFVFDD1BDFCLAlBEFDFEADFCFMLQAIGSUKEGICEECEKCIEECMCAAcWGACMGIKQEEEEAAEEIEADQCEFEAEHEDOFEAGLIHILEAEJEJCCJLHAFJFAFKJADECMNMdFANJDARPTFJHFDJTCJDDARFPFFFJRLADDCCmCKkBOcAgBWYGDECaWGOAOFKNKFANRLF1BmBVVAFFFAZGPEDaMDQCIqBcWYGYASLOPAHFDDHlBTTLFPN5BuCNDJHDPKjBUTKHCIUQACNENMHgBLGoD1D|yLmNIJAFVTVCLFLNFPALMRHJCFFAAFHZCLFAALDHCZFjBG5BCAAFCAAJKLSCIGGMECEIIIIQEQDmBOKGOKEQAECISDSNEDQRYJGDEAFLCJAAJFJQdAJELLFNNDHFAAFDCADPNALDCCJFJCJDAEVFLJLDYCaAeIsBGIEQHYAEICQFKMMLGDFMLCQQGOAOFMNKJHJNLDtBsBZXHNDZGNcAEEFQEMsBgBUYEMAaLOPAHFDDHnBTRRLhCoCNDJHDPGZELUTMHAIUQACNENMHgBLGoD3D|yLmNADIHAHZXCNDJNFHFAHHJFTAHFNAjBCFDpBEhBEPAjBMPQAIGMcGGDEECEQDGCEDAAOHKAUGKESQAEHGCAEEGDaLHFCJiBNSOOAMIGGOAMHQLIHALRLFvBsBZZHZCRKJKDAJJHDHCPCFMECDGQOKAKNGFOEOOOWOACEAQQIOEmBLOPAHFDDHnBjBdhCqCNDHFFNGdELQTQHCISOAENELKJiBLGiDtGFHDNFtBEAAMGMIGJgBG2C|yLmNAFIHAHZZFNFFJPFTCTDAAPCDAfCAAhBK5BAhBKPQAIGEIAICEAMCAACCADCEEAaFSLICMFIAQEAFAAUMAIJAFGCAWDEDKDAFLNFAQFEDWEQacISAMFMPMJHJNLDpBsBbZJfGVGFCHJFARILEAASEGWOLUEQYWGAGIEAQOISEkBLOPAHFDDHnBjBdhCqCNDHFFNGdIRQPMHCISQAENELKJiBLGoD3D|yLkNADIJAFtBvBALFDAVALEADREHCPCDAJCDADEPEnBMhBCfGLAFGFOAKGAGECAUEGAgBHSJEJ8BIDGHDFEACCAMJYJLLFFsBCIIKIGQSGSAKFMPMHDLRLDpBuBbZJdEhBLJANKLGCGUKIKCGGJSEQaYEAGIEAQOISEgBAGLMPAHFDDHnBjBdhCqCNDHFFNGdIRQRMFCISQAENELKJiBLGoD5D|sKyOfdFVATFJDJJDFJDNILEDIESJDXCDDFEAALIPGVKREAGRDFIVAJEHGTEFKhBCAEJGHQAIGAGECE4BFMNMAOJgBAEIDCCDOFECEDADKNHHEJeESQOMSEMAQFGPOHAFJJLJDADIHAJXZJZDADKHERFHHHGCGOEKOHWEOaWEAGIEASUIWCcLOPAHFDDJrBdZlCqCNDHFFNGdMVMNIFGACIQQACNGLIJkBLGiCrC|uK0OdfJbCTPJNFJNAJINMAENIJDJCRINKJOZEFEHOHAFEFDFEAAJEFAHCLShBKJAFEDDFEHEDEHEFSAGCGOCACyBDCFKHGCIFAFYHMCKFKHMCEHIPADEFSFGCQCACIIGMWEWHONMHAFLJLJAINFNTbHbIjBGNOPIFCVEJDFEAIlBJIAMJSAEFCDMbQJSPODcJIAEDACGMGCMDEAkBQUWQWWIiBAQLMPAHFDDHpBTTLHnCoCNDHFFRGXIVMLMJIDAKSOACNENMJkBLGkCpC|uKyONPDARTHZCVjBHNPAJGNOJAVGJEbGDAFQLADEAQVIFEFOAIJDFGNCAADCJEDAHGFAHEAMTCAKNEAADEDMTYAMQAuBFCCCJODIAEFCAGFEAGFKAGHEPiBTODKFCCCHKAECADMKKMcAWFINMHAFLHHLFADIJANFDPZDZFFEDALOfSPAHCAGPEDAHEHAJEFENEADDCADDCFEAANEJCNHEFGRUJWFAAKJKCCRKXITUPIDQFMCMHIACIASKAGEEDiBEM6B0BIgBDYJIPAHFDDJrBRTNHlCqCNDHFFRIhBKPONGFIDCMSQRELMJkBLGkCrC|uKyOfjBJfANpBHNPCFFFENGHDDKHDbGPCACLCAAFMLADYLMNADUJUADFEAMdEADFEAAFQPINEAAFMJGAAFKHINaAGEGMDuBHKDMFEAEDADIDACEFCDGDCDIDCACNKAEJMAEFAFGCCRQHKACDAHKCUGGKYAYFIPOFAFLNNHAKJANRbAlBMXAFEACHMNDDEAAFEFADEADFCCAHECAFEAIVEDAFOXGVEJAJRKDEDDAERMAEDAACFCFGCCFADGCEFADKFCAGHCFIFAACFAACDDhBIPOJCAEFAACLCDEAEDAFKCWCACEDKDCQEQIEKCiBEI6B4BIgBDYJIPAJFJtBRTLHnCqCNDJHDPIhBKPUTIACISQDEPELMHgBNKkCrC|yKyORRJHAHJJJdHNtBHRPDPETEDEhBEJCADDKJDFQNEAAFYJWROFWActBYVGDAFQJEAMNIFEHYACCEAKOAuBFACEDAAENSCEFAAEDCACFCCCPWJGDIFCJODAFIZUDECEFCAEHECGFIOiBAWHKNOFAFJNNFDGJCNNXAVCTKTADabELIHOXEAGLYvBCRNKRIACFDTQLIAGFCDIHCCCDAFMNOHALGhBEPMfMNQDUEIDGCEIGaCOIGKEeEKiBiBMOCAIIIeAWLMPAHFDDHrBTVFAFFpCqCNDJHDPIhBGJUVGFIACIQOAENEPOJkBLGoCrC|uKuOFHPNJNFJFXFJTJpBFTPDrBEDDPCDALSVqBXKDMJUHKAADYFILELIFMTKHCFMJEAKLWHEJMFIJWDIEMSAUCAFOCEDAAGFADMDAFMFCAGFCAGFCRWHELSJCNSRKJKAEJGFUGMAIEKAOHSPOFDDJNNFDAFIJAJJZAREVQZUREJWVEJKLMPUrBAPRMbKDEPGHIHCDGNMAEFACEDAFCAENKAEFACCFDLGPCACHDAEdCFGREZMRMDWCOEEQGcCQGMMIqBuBsBKOIcAULOPAHFDDJtBRTFAHJnCuCNDHFFRETGRKRSPIFEKQOAEHATQLoBLGkCvC|2K0OfhBHPFXFHXJrBDRHHHHNAZFACHDADJGhBEFGJKDAFKDIFQFmBVIACDSACDaDOPGNWVONOFAFKDADEFWFCFGACFQJAFcDGCMQCYEADMHICEFCAGDAAEFCFEAGFCCCDAAEFEAEHEDGNOFAVYHCNQTKAENICCLIFSEMCeJSNOFADJLNJDAFKLHrBCDALEPINYXCAKNIDAFCAKNGDKPQPCHGFIXIHERAJJCZQLADEFDACPGJGHEDDDEFCDEHCNOAIFAHKHEFGHACEFDJCCEHDRELDAEfCCCFACCFDDEHACCDCFDFEDDAEXGZKAQCMECAOWCECgBEQEGEIIGMGgBwBwBKQEUAWLOPAJHHrBLLADFHHFvCoCNDHFFNEZKXORULEMOMACHCTQLoBLEsCnC|wLqQFhBLLAHlBhBFJJPFXHHPF5BFRHNLFJAPDDAHJPAZEHDFEDOR0BPCDKDWNgCHQRAHUPQTGAkBVSFEFIAAFIAEHEAGHcDKGIMGYAMDAAGFAAGDAAGFECCLIDGACNUZYFAFIJGDEHANOTKACHCACVUHOEqBJSNOFADJHJHHHDCHIHFpBEAAVEAEPEDADCDCAAFEFECINCCCFEACHaRsBrBarBAPDFlBURCNIFDNIFAVULGAGXYJAAEDDACDAACFDDElCGnBSbEHEAEFDASGMECDGEAAIgCGSGACGCIIIMGeqBqBQYEUAWLOPAJHALpDSNDJHDPEVKXQTQLEAEOMKAEFAVSLoBLGmDT|yL0QJvBHFDJjBhBDHNRDRHLTH7BFTHLNFAFNAHDADLFFAFFHAZEJADCAAFIHGJ2BPMJSFKHiCFQRADEJIDUVIHMFEFGAAFKDADQFaJAFMFADMDCFQDOCOKCKCAEgBFACGDAAGFAFMHEFMHIDEHEDGdYLMFEHAXWTIACJEDGLIHOAqBHONOHAAJTPINDXIhBAFCAELGHADEACHGFAFCCEHCAIHEDADIHCCGJECAFEAMLADEAaZDFIFCFIJAFCAGLDFECAFCACDEJARLAHGDDHCDELEACFDNGFDAEFDACLCbOFEFAAEFDJKDALICEDDDGTUFDHEACDAACFDDEHDtBGPACCFDZIXMfEHECCHAASKMAIECAGsCIQGOMGKIcoBqBOWGYAWLOPAJFvDEHAHFFREVKXQVULEMOODCFAVSLqBLGHAuDJ|yL0QDdHVdhBNJHRHFHZHHRF3BFVHTLJJFJDAAHNVAXDFCJGNIHEAEHsBJWJCFODEFOFiCFKJMTEAIFEJEAAFIDEHYNQFIFAFcFIJGAWNcDICIMEAAGCCCICWJSVgBjBkBNGHKLCACLGDENKHAFGLCFIRMJYCEFeTYFADJHDDJHFAHEFCLCZMhBYZAFWLADGAAFEAILECGLKDMPKHGLEAGLEAAJGFOVAVJALEAEDDACDAHEFALGfGnBSAEFDbYDGJKHEDDHGHCACDAACvCGvBUPAJEFADCJCACHAASKOAGGAEIyCIUIKMOkBqBsBAEMSEWAWLOPAJFpDGNDJHDPEVKZUVOLECCIOSLGRQLoBLGoDJ|yL0QDfHVlBnBFLLNHZHFJFrCHlBPLJDJFACDFJHFFNFdEDAHILMHEHuBJQLWFSJoCFQPCFGFAFCAGDGLEAOLADKFOJ8BTYPUHSAMEEIGCDEIMAULYHEJSrBqBFADGFAFGHACEFCHADEJEDEHCHIXIFIFAACPKJUHkBRYFALPAHJHIPEdKZMRQNADULAFIAOPGAEJOHKNGACFADQPOVCAEJGFELDPPCPKFDACDAHEREJAAEFDPEDCFADEJAXOFDJMFAJKHCCCHIbQACDADCDDHErCENIZIDDDCNEPCFCFADCTEASIIACECAEIEEEUGkCEUIIIMSKcgBgBQaEOCiBLOPAJFpDGRFHPKpBGNSVQJCAEOOMDEHCVQJoBNKoDJ|yL0QDfHVlBnBDLPTFRJJ1CJlBPHJHAAFHFDHJHAJJHEHFDCbGFAJWNuBJQLqBNuCFYbEAINGAONgBR2BPuBVWAKEIKCIEECYDCDONOHODADENKLOHAPQFANMFAFGJCACLGHIHAAEXIZULYHeRYFAJLDJLJADKLEbMbKJCJCCADGFGJkBVIJEAEDAFGDAFCCEFULMTIDCHGDAFGFOVCADFGHDPNAVM9BQlBQNMFAbcHANMNELAjBEVDlBKPIFDACFAACFDAEFDDCjBIHAACFACUIGDEGACIKEgBI8BCWIMMUqBegBQaGaAWLOPAJFpDGRFHPGfENGLUVOLEEEOMIDEPINMJoBNKoDJ|yL0QDfJZhBlBDNNRFPJJ1CJlBPTRAFLJFHCDDAAFFDAdELCACJYPwBJADkBNADSFoCFaZADCAGFEHEDCAIJgBT6BRsBVUAOGCEGECKECCYHQRYAEDAHIZUFIPIDGFAFGHACELCPONEAEXIFIFADENKNWFcTWTbEJANEDCPOdKJEJKJADePAFIDGHIDELECCFGDADOHOTGDCHMLELEAIPAFEADRPAVMHADEDDZKXEDCbKjBYAEJGJKHAHIFADEDALEpBAFEVDLEJArBSHDACNAHEHAACTEASYYgBI8BCcOIISoBacScGWAcLOPAJFpDGRFHPGfEPGJQTUPEEEMKMPIPQJoBNKoDJ|yL0QDbHZFLfjBDJJNHTJJnCHxBRJJJFJNFDDLDAADFDDdGTGDIJYHCDYFCDKDsBRuCHabQLAHIAEHKDGJOFKHIAULIACDaHWNeAOKCGCAGYDOHOFEAEHCCCDAHIAGROCCPKHIFAHIFALMhCoBDETOJWDAJaPSFAHPFFDVUvBedGDeTEFIFAFGADFECAFGACHUNGLGDEJKJAFQVEJDNNARKNCAEFDDCXERIFAPIHAACFAFENGDEPIDEFCACDANQdQrCEhBKHEbIRCHEFDDCFAACDDFEAOEGUSkBK!BCaOIIUsBYcQgBEqBLOPAJFpDGRFHPGhBEJIRQRADSNECGQIIAEPINMLsBNKoDJ|wLqQFnBJRJHVdDLDHDAJRJLlCHxBRfbDHAFFDCFDAAFFDAVEADFCAAFEJGFAFEACFKFwBLePMAEFwCHehBCAADEAIJIFADKDCHGDwBVeHYPkBAQSEgBLaHCACHMCCRKVYHAAEVSVKFGFAFGFAACHCACRGXWXyBLMHFJVFHAHOZCJCADDEDCJORQLADYPMLEAAFGAADGDAFEAADMNGAgBjBEADFEAObDPNAZQrBIZOLCPIDGJCJMLENQRKvCGtBONGZEREDEDAAOCGOMEEEAACIACCWEEE8BCYMKKUuBKIQWMcEqBLOPAHFDDALpDSRFHPInBGPSVKLMHCAGQIKAEFEHCRQLsBNKmDT|yL0QHxBJRdnBAHNZJJnCJtBPfZLZAVGRURwBL4BVkCFiBjBEAGJULCFwBVgBJcPgBAOMEIEcNcFCJQhBiBFAVU9BmBXWXuBLMJTNNe3BYXuBdYXEAiBjBShBDNLAbOzBONIPEROFANOFAPSVMvCG3BUjBGJGAOEIUOkBK6BEUIOMWuBYgBMcEqBLOPAHFtDGRHFPIlBIRcfMHGQKMJIFARSNuBNIqDJ|wLqQFpBJRZhBNjBJJhCJnBPFFNHDHLHHLAHDAAFDAAFDDAREACTCAADONSFEFWFADKDoBRMF4BDMRGDKPIDEJSJDFEAADQHIHWLKAADUFUPiBAOMEUCSHMAGFEAEHCCCFACEHGAEDAACNMCCJGLMHARU9BqBFGJIHICCFALaPQHLLLGVDFGHCHCAAHORCHQPOHEJGACFMJEAADONGLQLUXENIJENANLAXOnBKHEDAACDDFGFAACJCHGDDDELEAELGJMHCAEFCAEFENEFGpCGACJAACFALGLCACPCHETETIDOEIWQEDWIKAEEsBCUKKKUuBWcMgBEqBLOPAHFDDALpDSRFHTGhBIRQVYVEAGQKMPIRSNyBLGmDT|wLqQFpBHRVZNlBJP#BLjBNPNHJFAHNCFFACDDDDVCFAFEFDFSVEAQJgBJMJUHAD!BHCHgBlBGAOPEAADMFKJSJKACDIDaReAMMGkBHSFCAEFGJQJGDILIDGJGFADIHENONGDEJIFAFGFAFGFAAEJEFIJINcNMLNANFNKVILELQPCCEFKNGAKNIDoBrBSdELDDEFANJANMZIACFDNElBUTSAENKHKJEHInCGAEFDDEbMhBINKAMEIQMEAIEIAOGqBEYMKQOmBUcMeAKEGDKCSLOPAHFDDALvDQHAJHDPIlBGPMNEJYXGACMMOAEdaP0BLGHAsDT|wLqQFrBTfAFJLRtBJFVAhBJjBTNRDAAFFDAJFHARCAAFDFGNCAADEFDDOJAFUHIAgBREAIH2BHEJEDGNMLCHKHILOFQPgBLQPKFSAQKDEEAAEEMCYDAAEFCFSFACEDAFKDCCCJCHQNKAEFAFIHEFI3BuBCEFAFECEHEAEFELWNDDNJNAFIRYjBGDDDEFGAMLAFGAoBvBELIHCLIPATDEFADEPEAEPEACHDCEFDCCHADEFAFCNKJCCCHCRQFMFAAENKAEFAACDAACLELAdCFCHAdOVGAEJDACJANMEUMMWEMGmBEQGKMOsBEEEMMMMiBEkBAILOPAHFDDALpDSNDHFFRGhBIVMNEJKJMPIDCMMQAEdaHOJoBLGmDT|wLqQFtBZrBPtBFFTAfJfRRVFNDfEACPGDAFEDAFEDAFQFMDCFIDaRyBHKTIFIRMLEHIDQPYJIJWPSAOKGUAYLcDADIDGHCDINODGPOFKjBeLMDAZwBDAJTNJCDFFEDAFEFDDEADDCAMZONEHKHINECAFEDAFEAAFEJQNAFEFADCAKTAFEDEJCXFADExBYFIHACEFEFADELMACFEACDADIHACELGFGLEbADEFDTEDEJCACHCTMRCAEFCDECQEIIGCDaOkBEGGEAMMKkBMaIGOqBCoBLOPAHFDDALpDSNDHFFNIrBGPSVAHWVIDCOMSfcJUHkBLGmDT|wLqQFtBXpBNvBRDHFRFfZAFJFCFHDCDDFAHFJCPCAAJCDENGDAHGDCFQFIJADKDDFIDAFwBPIVIHELEDINGDCFMJEHQHGJKJCFIDOAQKCIDEEIAYFKDKLWFCDMHEFMHEDIJEAGJKDETSHKHCAGFECEDAJYFKJTNFFJIdOVaZEPIFKVCCAFEFAJMTITALXQHCVQJQJIDMHCCCHEAEDDFECCFAAENAbKJAAEDDFIJCJIVGFKASMMQIcESMAEGGAKGaKSAIIEMgBEQAiBLOPAHFDDALpDSNDJHDPInBGJAJQTEDAHONCFKHEACMMShBeHOHoBNKmDT|uLkQDpBVnBLrBLDTNZdFJAFDDDJCXCFCLGHAFEAAFOJCFYXcPAHEDADCADHMNGREDIPEAAFCAGJGDAHOLAFKFOAOMCOAgBDKReAMHEJWJIHSZeJwBFDHPJALLCbObMLKbGFCLKRCLOdANZcFMJKFKACFCFKRKVKZaLGFKAOEGEAGIQACEGAIGEAIOAQGeKWEEOoBCqBLOPAHFDDDRzDWHFFNIrBKZKJKTIFGJODCKGEEKbaLQL0BLGHAqDZ|uLmQDtBXzBFXTTFNCHLJDNFAAhBIXEDADMNCJGDDFEDCHWZKhBEADFCAAFEAAJUlBGDDDIHQAGEDCGECwBDCDOJQFUFIDIFEAGFEDKFEDSFGFAJOAwBDCJFFGCaEIAIKUMeEcAYLOPAHFDDDPzDUHFFNItBKZkBrBGCEEGAIMAIZYNUL0BLGHAuCrGDFARGNMNMZQRNkBHELUDOHCDIFAa0F|wLwQF5BVvBLvBETFDFLDVCDALENAJGJAJEFCNCACNGNKtBEADHCDANEFCbGFADGHOAKKAyBFUHKDUDEAEDCJYDKDCCGEAFMDEFDDOFAAUKQDOJGAYIcMYIqBAYLOPAJHDFnDMRFHPItBOdgBtBIFEKOOAIZYFKHGFIJwBNKmDN|uLkQDvBTpBDdDAFHDCDZEACNFFDLAdCFDPElBEAAZCHANCDCZCACxBMPQAKOIsBAUHKAQEOFiBCEGCAOHCCGHKAcGEAODGLEDEFWEWMaIqBAaLOPAHFDDDRnDYRFHPItBOhBiBtBGCEGKGGKZaHOHIN4BNKkDZ|wLwQDzBNlBDACFFFFpBLEDGDACEFCAJFACFDZGNDDFPCVDDALFPCLDFAtCANEAAvBQRQCEEGEGQIMIUAgBCICAAGGGGIIcCEICCKLwBCQFKFGXIFCAEFCAQGYGUCAIsBAaLOPALLnDMRFHPO9BMbYfaCAKEGPOVgBPgCLGqDjGDPLDFfDzBE1BAcEWACEEDEIEIaKQHiBLKH0F|qI8QNDJHDPKxBQlBQZEFUFAFIAAJFAADEPEJAPDHCTFHAJFDDRJVCDHZCJFADVGpCMNUDQOEIUSIOMwBUIIKDCGECIMIIEGQDGAOJUAIFGAILQVIbGDYQ0BEWAkBLOTDHLF5BPpBDpBMbMNGDCEcFDHEACJGZALVTHLPHPLAHFDCHJnBNRLJAgBDEAOGkBS4BCmBHEAQHIJGFKJGDEAGNMVkBPgCLG|kI6QHAHFFNO1BDFe7BKJKRCLIPDPATVlBCDHJAFFDCDDDFPANFACFDAAFDAFRC9BCNQPQAOIACEAKMICCEQIEIECKQAEGIDGECAIGMUCICEEGAOSaKKQAYDAAGDAJaJEAMPOTIjBELGAYO8BCuBLOTDHLDvBPzBAhBCFALGLSRUFSAKHCCGRGFAJEDEVTJJLLFDHJCVJJCDHFAJNAFDACHHNDLHNFJPHDFTLDUAaMmBOeGEDCGMCICAAICADSEOHIHcHEPYPSPeN8BLIJA|qI8QNDJHDPGZMtBQdEROPOhBALDFCTFDADNPCFHFFFCDDANXFFJZDACFFACFDAHRA9BCLSRSAQKEAKMIASMGAEGMISiBGQCACEWAUEQMECACYIMIAEIEDCGCAcFACGFCHQFEAEJEAITSdKjBCNGDgBM0BCuBLOTDHLDvBNxBEvBENYRUFWASHAFEAAHEAEHDDGFAFCCAHCAEJCNLDFFFCAFFCADFAADDCDHHAADFAAFFAJHnBDHFFANRCFFAAJDACFFJDAHRFAAFFALNHAJHTHHHFCAkBEEFEOkBCAAEEDDEEADEMSEGEAAECDDEEAEMECAECDDGEAAGCCDCAMCADIEINkBHEFOTWRiBPiCLG|kI6QHAJHDJOlCWvBMRGNIXANFRAFDAAFLJCDDAFJJFJRDADJJFAJJJDNDAAFDACFFAJZA1BGNQPSASIACWMgBMGIIEWcKYGEgBASEOMOECEcIGIGEAEEACcHMFECEDAFKLGLQNIhBMnBCPGFQAUM4BAmBLOTDHLDvBNvBExBMRUNYFYAUHAFIAGLKLCHGLAHZJRNFCADFAFHFCFFADTCTFLADFFCAFFCJJJVDAHPNTJHDCCFFCADFADFHAADFCAFDCFFVHPLDqBGEDECIOceoBIEDEECEMCACQCECAAWLgBFEJULMTkBNgCJILA|!H6QJJDNK1BMhBe1BGRAXFFDNRTNLFJHDAHRRAFDAAFDAAFJLCFFAAHFHCDFDALFAA3BMVIFADWAcOEEGAGESEeQGIGEKQECISEAAGCAACGEqBAQEiBUSEYKDCECIOAUFMFCAEDAHMPMLOrBQ3BENEFOAaMyBAoBLOPALLDzBLrBAfGXMRMJYHmBAiBNUVCJEDCLLFFATHdRNDADVCJFZAFADFHANNNdPTXPhBJHFDADFPFAFHADkBMcYkBQQGIMKDCGEEMCAAIGKAaJcLOAIHKDAVoBN!BJKRA|!H6QHFFJGtBQxBc1BERAXDADLHJHFNRLFJNHDFJJJFJLJAHHFALJLFLCDFFAxBKPAFMHADYAQKMEGEGAuBQGGKCacEAAIEAAEMSwBCUESKOEIGqBKOMAGEADECAASFECCDADECEHCDIJKFAXYvBQ#BELCFGFkBECIuBAqBLOPALLDzBJpBAlBGVSRADMHgCFgBJMJILEAADMRCJnBLADFAhBRHACDLCCFFAAENAVDCDDAFCRDFFHAHJJFNbVXDCTNpBLHFDAFFPFAFLAAiBMeYgBQMAEEAECKOKEMWAGGMAYHYNSAKJMRgBNiCJKRA|!H6QHFFJGvBQxBYxBGTAXHLAFZVDFLDAFRNAFRPDHLJJPAHDAAHLVDtBINAFCAAFGHEAEFWAaOGAGE2BQEEQGEGEAUUCASe0BCWEsBUqBISOCGAUFMAEHCAIHCFIFAJKFCNMxBQlCEJCJGDoBKsBAqBLOPALLDzBJpBAjBIXSTOHkCFgBJcTAFECKZlBJHFDALHXHDFpCFNFRNPdXVZNxBNDDPHADFCAFNAAgBIQAECAGOECckBGAGICACCEAAEIGAEEAKIAEOQEUAUJcLQAIXuBNgCJKRA|!H6QHFFJGvBQxBa1BEPDVEDFDJRJDNPJFADLHXbFAAFNLAFDACFFDDHDAAHFAAJLTDtBILAHEFAFIDEFYAmBSOCEEOCOGICEESICEEAIMOISegCCWIKGMCKIqBIUOAGCADEEADQHQFCAIVOAGJCNMxBQjCELCJGDoBKsBAqBLOPALLDzBJrBAfIZSTOHkCFkBJIHCFMHGJGFGJAJNDADFAfJPJDCDDNFDFrCFFFHCHJNHHNCFFAHNVTXLDD1BPHFLFADDCAFNADYGODCEEDEIMIIEIGEAECACECAIMCDACEECAGIGECDMOKEAEQUESAaJYLQAIXuBNgCJKRA|!H6QHFFJGvBQ1BIHCPSjBAfDDCFHFAFPNDFVNVXLHFLFDAFFDLPAHDAFHCFDADFCFFAAFFFDpBEPIHDFEAAFMHYAcOOEGEKAGEYGCCEAAEKCACEAEGICAEGCEGKICGECAEGCIQ0BCcEAESESKsBIQKEIAIEAAQFCCEDAJSDAAELIJKFALKPGFEjBKlCEJCLIDIAeKsBAqBLOPALLDzBJrBAdKdOPQJmCFmBLCFGDADMHMNELAFCDtBNXJADDCFFHADFrBFNCDDRAADLARNPbbZPHDCAFLFzBNTNNADcEEIcIIEAAECAAEIKIEOSCDCEIEACIEGIKGAEMOIYAUFUlBuCNgCJKRA|!H6QHFFJGvBQ1BIHCRShBAfJRFAJNNHNNFALNPNRZJJAHDADJADDADJAFDADHFnBEPKPMHYAeOQGOCYKGAWKMOEAEGKICGECAEGCIQ0BCcEqBUoBGKGKMCYJWXYHAJKVKbIrCGTIFIAgBKsBAqBLOPALLDzBJrBAdKdOPQJmCFmBLWPGLEAITdFlBPFFDCAFDCVJRC5BHNHDJDCADFJFAAFDDCDFAFLFAAHVNDFHDDDHADFTHfHHFFAADRHDFNADYKgBCAEEAEIEDEEAEMCDUWEAAEKECEIECEEACEIGAEMOAEAEEDDEEIAiBDMlBuCNgCJKRA|!H6QHFFJGvBQ1BIHCRShBAhBFFAFFFPRNFHLHDRTHDAFFAFLFDHNJJPjBDlBERGLEAAFKHaAcOoBKqBSEIEAEGEAEGKICGGCMW0BCgBGkBSoBGQMEGEYLWTSDGHALKTKbItCGRIFIAgBKsBAqBLOPALLDzBJrBAdKdOPOJoCFmBNADQJKJKPAJZF5BZ7BFLDFCFFFCFHJAFHADLPDHJNXPADPFLJzBNTNLAFYMgBQQDECEQMKMCAEGEAEGEAUSAEMOAEECDEEIAiBDMlBuCNgCJKRA|!H6QHFFLK3BMpBGFEPWpBAbDFCFJNJFJNFALNFANRLJFJFFDJNPCFFAALFADJHxBEAAJCADHMPMHQAKCIGGAACEEGACEeGiBOCEEAEIEAEGQOAEGEAECAIQGC6BEACKAYOEAEEsBKOMGcDAAGDAHSDARUHCLMLGfKnCGPIFIAcM0BAmBLOPALLDzBLvBAbKbOPOJgCFgBJYVIJGRLFVDFFJDADDCTLFAADFAAFNAADJCCFJEbFHADDNCCFJAAFFCDFHDAFFDFLNPDJNHHJNFHHFCJHXHFAfRJAAkBIUOQDEECCGKGCGmBiBOSIWDkBLcf6BNiCJKRA|!H6QFDHPK1BMnBIHAJavBCdFHCFFDRXLHHLHFFJLJCFLJAJDAAFJHLhBA3BOTKFWCmBUSEEEUGQOKMGAEMGGGOIGkBCgBIGEACSGCEiBIQQCIAUFEDKVcFCLKTKTG9BGPIFGAYMoCAYLOPALLDzBN1BAVMdMPMH8BFYJEFCCAFECEFSVENAHZFAFFCFFRJDCADDAADFADFJDvBFJAAFFCFFFCAFLFDHFFPbRRPFAFNHNFFCAFLAAFHAJHRHAmBGUaoBYWAEEDCGGEGMECIgBHmBpBsCNkCJIRA|qI8QRFHPGpBQtBCHGDCRGDALGDOdEbDNjBrBDHLLDHDAFJDAAJDAHNJZCFFAA5BIFDFEDDDEFMHYCDCGCACICKIMCEEICCEaICGWSDEEGEAAIEGCADCEAAKEAACwBEACOEGGICACICEEeIQSCaFADEAKHCCELMHKXSVK7BGLEAEFCAcMoCAYLOPALLDxBN1BAbGVQTMH!BHOJCCCHGDMNIRALJFNAJHNFDFLDAFNFtBDNFJJVrBFDFFAFFAAFHCNLHAJHFCAFFCADFANLPFAmBEEDEEADECIGMCAACCADCEGCACGKKCIKMEAAEEAAEKIDECDGIGSAiBFUtBsCPoCLG|oI8QPFHRKzBOlBEDGREDENEDSnBAdxBrCPrBDtBCPKTKHWCQMyBYWYQmBgBCUGUOkBOMSAUHSTcTSXK1BGHGDcOuCAWLOPAJHDHDvBN3BAbGVORMH0BHOHUZGPALNDfRDFNFnBDLFLLLdRZFALLVHVPHAAcIiBUmBGEAEGEScGSAeJatBuCPiCNI|qI8QRFHPKzBOlBGFELILELIHGNKXCdFDHVPXAJFDAFFFCDFFFJCFDAFRFRCJDDAvBCNGHAHMHIAQGACOKAEWMIKEAEIECKSDGEICADEECDIEEDCYGEEGCACKAQIQCCCKCMSAaHIDMFCAGJQRSVKVALDPEAmBECDCCEMiCAYLOPALLDxBNxBALERDfKPQFcAYHEHAJEDALKTALPDRJNDNJLDHCNHPPFZLZFFAFJHRJFJFCDHDACIDaEEDIEUOgBEKEAEOECAKEADECAACGODgBDCHaxBsCPkCLG|!H6QFDHPK1BMdIJIRIHAHMNINKdCVDAFNDTFDFVFHDTDAFfCPDFC5BCAGPQFOGACECDCEAEKQMOYIUFMCECADECEAIGIKECGKGYAIFGEKUAQXkCTKHAPLTIHKKICIAWIYIuBAYLOPALLCLFFAnBRxBGFGNEPNHJLTgBJIAELMFIFAJSDARmCLGLDiD1FAhBZpCFtBCXGEMSAQEUAOECDCiBeQIYAHOCkBTObHDDVAnD0F|qI8QNDHFFNCTGbOlBMNAFGJIHAHEFKLQdENAbEAFAFlBAJDACJFPCpDKTQDIEIOEADEKOKcCSDGHEAKCGDIMcMCKFINECCGEADEGQFUHQAMDEREMGAOFGNGAFEJDAAVHjBDDPAJFNNFNFDGeAkBQOCKNIDIVELQJGFKJIHMHENWP!BLGoDJH9BPvBIDKLCNGDGAEEDQGWACEKIuBAYLOPAJHpDI|kI6QHAHFFNItBOhBYdENSRShBIhBA1CIxBAtBEFADEHQDMKAIEAAICCEOCYAWJIJCACFAAOECFAAqBMAILCLCAAFEFEIAQCELkBAEDCAECAAiBJIENCTAHHFCDFADHHDPCJMISLWdgBDILIHMLILUN4BLIJCsDVFxBRvBODMNCNGCAYMcIuBAYLOPAHFDDANvDS|kI6QHAHFFNItBSlBYbCJMLCPELAFENCADTEPAhBGTCDADCDCTMVAHCAOnCEHGFDDEFSFKIIUCADGEEDyBRKCEFIEEFADcDEAIIAEJAJEDAaLcAIDAAoBJIFDELCDARCACFRDHhBJHHNDSFCFWAKECEIAKFKAUVWDINIHMNMLSL0BLIJCuDJH7BNfDPMDMNAJEDCQQmBCaEOAYLOPAJHvDG|kI6QHAHFFNItBMbORCHONEHQRJNHdCHFFCtBEPGLGFDDIHEPEAGLQRIdEFMhBWXKFICKIISEKAeFMNKAGDCCENoBEEAFAIV4BFgBJIPAAHGLH3BKTAZMpBAJENKJATPaLiBbaFONKFMFoBEIIAAKFGFOKASGhBiBAGNIJONINWJwBLIJCsDVFvBPdALMDMNAHEACKCAOmBGkBAYLOPAHFDDDNtDS|kI6QHAHFFRInBITGLMLAJMNGAEJSVIAMJOFGJCNEJDFEACJCdgB5BQxBAFINCNHALIHOFCAEHEPkBPMbMDGLKRMFICIDACYGKMCCCAGHIFMFGNDFFHJHFNXDfEZEFCJONMJCJMJcPAHEDADCDGXIFMZEDCFGDEHGDAFGDAFGDIHKAACKEKUAqBHOHGAIDCAGDCNkBJIAENUCCFCFKFCAIFECEFACEDCFWNOJCAIJCZYJOFAdeNWJsBLIJCuDJH7BNXDLMDMPAFEAEIQoBEeAYLOPAJHvDG|qI8QRFHPIrBKXQRCJGFEHGASXGFGAINMJenCYbMZGDDDKLCHDDILDDCAAHObCNFAFGPGDEDDDGNIAEFCFKFCLSCCFACEDAACDAACFCCCFAFGpBKVQZMAMDICMCAEIEACECDACGEQENMFQRDJJNHNVFAFhBEXEDCJSPUJCJGDMJiBHELEDKZIHQVMLMHCFMHAFGDIHUCCGGCAKECAiBLaCEFAPgBCEFAJKAEJGFICEHEAELIJMFCCEHCDEAEDAAEDAAIFENcJGFOrCkCAENUHoBNImDRFtBNXALKAOPAFKOMiBEYAYLOPAJHDLnDS|qI8QRFHPIpBMbMLCHMNEDUXMHALEDCAGJEAENIFENEAAJCAQhBKJDFCCAFEAGHDDECCFDDEAADCAKJKVKJAFCCQdCLGHGXJCFGRGJILCAEDAPSLGJQAELICCFAACFACExBIHEFAFGRGAEFDACFAACJEJCAEDDDEEGFACEDGCKGGKCCECDIGSCAEJILSTDZPVZCDDDFVERCDAHEFDFGFCFMLIAIHKDGDCHEACFIDIFoBHYpBKHADSTSHGHEAKJGDAFIDGHQCCCEDCGGCAKECDCCCAcNgBJSFAAIHEFKNKJKDIDAAEHETUDAFGHEAGHEAIHECEFALYHGHOtCoCHMHIHoBNImDRFtBNVAJMDMNAFGGEIMgBEWAYLOPAJHDLnDS|qI8QRFHNGnBOdONDFMNGAYZEAQVKHmBlCefGFIJEHIJADKJMVGFGNAFCAAFCAAFEFEVLELIDATKDDAEFDAEHAZSDEFEdkBDDRKfCNCAEHDHGjBMCEFDDELCHECKFMIKGEKAEEYEMGFQJCHGJCVDDDZNRPJTDVCRIJAHYREAcPGAADKH8BNILCACHUZURGDGHkBREFIFADSJWGIKEeJYJOCCLOAEHCAGLIRWFEFIFAPQHEACVSlBiCtBsBRKJIPMNWHmBNImDRFrBHNHHCJMFKPCAIIMiBEWAYLOPAJHDLnDS|iI6QJDHTGdQhBYdKFGHSNcbAFIJWtBIJINQRGDMNIFOTEADDCAUXWhBGPAPNGDEDDAEJADELCZKdSROFILIAELKFAFEJCAEFDACJAACNDHEbAxBUFEFADEPCFWKMgBMeEGGKACGQAJMHAFKJDFFLAZCRDjBRPPFLDAFNAZERGFCFULCFaHCFIDSLaHqBFQPEJYbIDAFOFCFGDKJODCFIAQJADIDAFUHIAKGEAGMCAEgBHMAGFCAIPSDIFAPWLIZaFAAEHCCCFADEHCFGFAJKHEDGJGZyBVWDAHIHCPQTKLMRMFKHIHkBHKPCwDJFrBFPJLAJKFORIMIYGICqBLOPAJHxDG|iI6QJAHNGlBQhBYbgBTgBfAFKLIVEADFEDADENYdEAILoBZMRWTWdEPEADDCAAVHAbQJAJGFDAEJAFEFDFGFDFCAEFDACRIdaNSTICCHDAEHDCCjBAAEdAXMHAZMLATGDWGIMIgBKoBCEEIDIGMELMHAFMfDADPDNCRFjBRPLFHFACFDFFACDHHCJDAAZCDDDEAALWTsBLDDsBR!BHOPEAMRGDUXSHMHAFGAKFIAIJUFSNaDOKIQAYCAFEAKFCCCDAACDCCCFACEFECCJEJKCGNIJMFCHIFATWLEFGFAROFADEFALOFAFIFCFGCCHGRkBVQAEFAJMHAPQVMNONGFMHIHiBJKNCwDJFpBFTJJAFMFMRIIEKKYCSAWLOPAJHxDG|iI6QJAHNGlBQhBYZcRoBhBAHIJIXGDDFEAALEAEJEFADIHINEAKNCCEHGACFEAUNMPIFKNGDAFQNAFILCHEAAHGHAFCADRNCPGDEFAFEpBKhBQJKJCACNMACDDDIFDDIJGHADEHCAEJClBAFEfA7BYVAAEJAAaGECEOGCEEDgBKyBCUKDEJKFAJK9BFdJhBPFJFAFHFAAJFAAJFACFDADZGTQRIDADsBJADKHcHKHiCFuBtBKHCFIAmBVODGHUFUNeDQKAGECDCEGAUCIFCDMHGCERSDIhBeJGRSJCFGHAAEJCACFAFGLEDERMLQDAAEDAAGTgBjBkBFARQXKNONKJOHiBJKNCwDJFnBFPJPAFMDMPIIQmBAgBLOPAJHxDG|kI6QLAHNGlBMXCHabcREFEAGJGDWVa3BKNIHGLECEJQJAFGACDADCAUNOPEDADECEJEAEJEAINECADCACJMNAFEAGNCJANNAHEACFDHEAEJAFENAAEDDHEZGdMhBcAEFADEDADGJGFAFEHCCCJADENAJCnBAPCNGHDCEPEFAZKREJDAEHDACFAAaUOEACEEDSGSEyBCUKFMJEHIFCHDjCHVHfPPNADDAFJDAAJDAAFFAAbIVMLQJiBFaPUDMHiCFKHINMJILMLGDCHMDYPcHKHSFEFMFEFcDMGIMEMCQAIPeHEPWFCNOLGDEPKLMJCJIFANKXMHINMAEFACCDANWDMFEHMdcLETQVKFGVQHMHiBJKLCuDJFnBFRJJCFMFKPKIOmBAeLOPAJHvDG|kI6QLDHLGjBOfYZiBVEAmBhBStBSbGDCHiBVIJGACHQJILGDCFIDCHIFEFAFCAEFEACJQRCLGHAPPDLEFGJCACFDAEFDACFAACRCHELAAEFDPIJCVOJCRSFAACDAAELKPGDGHDHENAHCRDLEdArBQREACJDCEVAAEJDDCDECUMKACCAIGEDCEKAaIyBCYKEONGHIPFpCHhBNHHLDHLLHAFFFHNCFFAAXITYRKAOHYDMJSFOHwCJQRKHKNWPADOHADMDEHQHgBHADYJIFQHSAQIDCGEDEEEAGEADgBHORSAGHCDIJIHCHKJCJMFAACLEDGRIFGFANGAETIAELEFIJEFECEDAACDAHMJYFCJQbaJCZUVIVULUFaJKLCsDVDfNXOFKPMKMiBAeLOPAHFDDDNtDS|mI6QNDHLGjBOfYXiCnBOROpBQZCACHMHKNYNEHCCKJCAADQLMNIDEJIDAFEAAFMLIPKJDFIHAPAFPALEHIJCHDAEFDACFAAChCUdSbcHAFIFAHGFDHEVCRDJEfAbKHDCEfIDCZCFEFDJECUOOGCGGcGgCEcKIQRGJKNFFFpCHlBNHHLFPRCDHDHRADDDAXCFCADDEJGFEHOJwBJMJsBNgCDMFUVEAORULGHKFOJqBNSJMAMHADIDGFWAGCGGEACKEACKCADgBJSPOAGDAJGAEZUJKRIFILEDEFAFGLCLKHCLIFARQHECEFAJOFYRabUJCLKJCHIZKDGRMFKFKFYJKJCsDJFpBLXOFINMIMoBAWLOPAJHtDG|mI6QNDHLGjBMbYZoCrBOTKjBMTAHIHADGDGJOJAFKDCFWLiBdGDGJGAejBDDORCFFFELRAZONCZIFAACnBMhBUXaJCACJEFENEpCEjCWjBEHECSEIEEOKeIkCEaKMQTIJKRLtCHhBLHFDFNFNRADHFHRAbIRIFADOJyBJMJsBNqCFGDQVEAORSJIJKFOJIAkCXYNYAOIDCGEDEIKAQDACOLULIAEFCAGJGAELKHACCVSRIbWJCJINEAERGACROLUHaFEDILOZULCJIJCJKbMVYFKFYHKLCsDJFpBLVOFMPIKMmBAWLOPAJHtDG|kI6QLDHLGjBMZUTAF8BhBcXENIjBMVAFIJGAMPOHEJGAIJCCIFADCAADEAQRGDCFIDDDEDADEFECMREDEJEAAHKLCHEDCRDFNANEAEJEnBMFAACJADCjBMHIRINQFAHKJCPOFDJElCEjCWXCRGCWECCGCAMMKAQGgCEeMIKCEJIJCJKVNnCHlBNVTCDHFAFHDFJALDAAbELYVMACDiBHyBTuCHGDQVEAORSJEJSHKHgCVYJGHaAMIACEEAEEEACEEDeHODACCLIDEAEFAAGFCACHGCCHCHIFAAELGHKVKACNIDENEAEHAFGXKAEHCDEROJQFcPabWPEFENGJIZMTSHKFeJILCuDJFnBJVMFKNKIMkBAWLOPAJHvDG|kI6QLAHNGjBKXYZGAMNYJGJIAeXGPGpBIPEDAFaZOJCFIAAFEACFIAEJGAINQJKNEAINMLGNGHADCFEDCTJDJCACFAFCACHEXGDDAEFDLEACFAACFDRGZKJMFDFEFAbeFALMFAACLCPAHCPDJEhBADEDDZIRItBIJGCQKSIGEAUGgCEaKMMDMNEJIHAFJJF#BFvBRDFNJRfAfIRGDAFGDEF0BLKHkBLGFoCFgBfCHULGJMFGFyBVQAiBTWAMGGMCACGCAAKEAAUFAAIJKAIHCAEFACCFADKHELOFAVWFALKHCCCJGVMLIHCACLETQLMCEFCFkBNWdYPEHGNGJIJCFERIRSFKAQFKJILCuDJFnBJRAFMDKPMKKiBAWLOPAJHvDG|iI6QJAHNGjBKXWVMFGJaLCHSHaVGLCnBOdGHCACFEAAFCAIJKFCHaNMPCCILEAIHUXEADDCAEHEAAFEDIVEDETNDVMtBMlBQPQJANMJOXQJCRAFC3BCDEDDNGLCACPEDCDDTIRANGASCAAGECCIEADECAEEcI2BCeMIMCONAPMFDAHLJhCFlBNHFLNRhBDZIRQRsBJMHGAEFGAgBNkCFmBpBGAUTuBTeHgBTYAMGMSAKCADUFGCCLQCCHCAEFEDIJGACFCACFCZaHAFIJEJIVMHIHANGFGVQFKCCFCDqBLQZWrBUDGNEDERINMHIDGDULONCwDJFnBJPAFMDMNEAEEMkBAWLOPAJHxDG|iI6QJAHNGjBITWXIDMNaJCHSHcVENCpBMbSPEJMFCHSJCFEAWXGAINaXCHEDDDEADFCAADCAENGHAPLDRMvBMhBQACJCJMJAPQAEHGVQJChCEnBMDEDDTIZCJGASIUECACQGgCEcMIMEOPCPMFFAHLJ#BFlBNNPPfDhBEFAHWTmBJ4BXkCFkBnBIDILEACFuBVCDeHgBTUAMGQcAUHECEFAHSFCDGDAFGCERMAGHCRUHAFIHAJMRIJIVKLMLGJQDsBJSZWtBUDELEFEVKRYAQHKHINCwDJFnBJLAHMFMNIEIQEUAWLOPAJHxDG|iI6QJAHNGhBIVSTGFEAMLcNAFMFKFaVEPDfKdYdYPDDCAKLCCEHEDAFMJMJAFIHEHMNIRGJGNFHEDHFZOXGrBURMDEVQDIPKFGFAACFAACTADCPDHENDNEDDDEDDACDAJEVGACFAFEdGLGAUEEDCGKDEYI2BEWMIKEOVIHGHDAHJJJDxBFhBLLLJTDNFHAdENIJEDAFEAMJYF2BX!BHMPONINKFEJIDADKFGFMFEFOJYFCFEAADYNYCKIGKEOAUDADIJQACFCAEDACCJICCPMDGTUJCAIJADECCFCACFADEHANOPGACFAXYFMAuBJSZUjBQNKPEDGTIRWAQHKHINCwDJFlBJTODKNIEIOEUAWLOPAJHxDG|iI6QJAHNEdKXQRADGDGHEAIJMFADQHADGDSJYREJARFNANIfehBKHMNIFKNWVELMNQjBALFDLIDAACJCAEFDTGAEFDjBSZYFIFAAEFEAETOHC1BElBQDDACDAJEZGJGAMEMAICADIGE!BIMEOOEMDKNEJGLAAHLNvBFRFLHFAJJFPARFHANDDALCAAHEFDHWXcHgBRQFAD4BHelBWRADKFaRcJcTUAMIIMCODYFEFMFGJSNMJOPMHIFAFKTMJKPGHMPMFMAMGgBHSZWxBYFENEAEVIJKDAHMAQNSNCwDJFlBJNAFODKNKEGOESAWLOPAJHxDG|iI6QJAHNEdKXcbgCfaTCNDNHLAPEHDJCAERMNEJmBjBSVEHEDAFEAEJCADFKJSlBAHDDHALIDAAEFDDCDALEACDDAELAXQCCHADGDDRQCCDAFEHMFCCCFAAERMlBELDTIACFAACDDHGFDAEDDLGACFDNENIAOECFAAOEADIEKsBCUIOOAYNALIJADJJNxBFVNHFDLCXDAARFDEXCADFEFMNCHODAFIAiBRIDGH0BHILCADDEADDEHONAFIHMNGACFGDCFEACFSHAFMFIAEJKHKFQAECACICKQCOAUHGAGDAAGFAAEFECEDAHQLIJQNIFIHEAEHGNGAETQFADIRQAcGQAUHMZWpBSRMJAFGTIPUAQNSNCwDJFjBJRQFKNGCIQESAWLOPAJHxDG|kI8QLFHNEZIVUXEAIJkChBWRDVJTAZENQVAFoBnBAFKJAFSVUpBCRFAPMZKVSFAAENKTeLILElBCvBYTGAyBmBESIMQCWNAVMFZ1BHTPDRGLFXCZOZcLoBXuBHMVMNAFSTEAURePEHSLQAOKGOCaX0BFCNWTSAEpBmBAEPQAWKYAQFMZY7BeLCDEXMLODULQJCsDJFlBJPIAMHGJGCIQESAULOPAJHvDI|iI6QJAHNCXIXQVIFCAGHoCjBUPFXJRAdCJKPCLcVajBEPEAAFEFAROhBAHFCHITINMNIDIJGHOFACEHMLKHCHDCCHAFCNAACLCzBgBCGLQAUYEYMKOAWREPIFXVHbDPPDRCAAFEDAXEFDJGJAHEDDFCAADELIAAFEAIJIADFSJEHULeFCFCADFEADDCFEAAHajBEAADKJIJYNEJIHIFQAMKCICAEiBVwBFEAGHECEFADIHGDGLIAEFGJGFIHEHIDADEAEDALQCYKUCWFKZYFA1BcLCFGXKLQFWJMNCwDJFjBJRMAIFGJGAIMEUAWLOPAJHxDG|iI6QJAHPEbKVMNGJGAEHoChBURFRNXDdCDMfYPILGNKNKZCfGXhBaPWFMFEAILODDFEFDACHADCJAACJEROJCRUAKNOAICADEMAEEEAUUEGASFGVEJGFJALJHdHNLDFAPCHEAETCDAFEDDDEAAJIRAFOREACHOJKLIFEFEAMJMAAFCACJCACJIJCNEAELGFMPURGLOJOAMKGOAgBJQCCHMFQFCLYFCDIJGDKHGNSJKJWEUMWAgBZWHCzBaJAJIVKNSDULMNCwDJFjBJPMDIFGJGAIQEQAWLOPAJHxDG|iI6QJDHTGZIRQTsBXsBTQPFRDFDAAFNRDfOjBWJILCJQCJPSAJFEDJDADOAPDETDlBNGNONcAMFEDGFCJALEbcHUCIDICACUFEMMAMDSDCPATIFbVDJFFHFJCLKRADCAOREXEFCJGHAFEAAFIHUVQNIAAFEADHKPAHELCACJMLCJGDAFEAELEDAJQLOAGGAEEAEGAoBNqBFEJYFEAIJEDMFEFMFCAEDCACFCJWASUgBAgBZWvBWHEJAjBULQDQFKHGNCwDJFjBJPMAIFILECIOEmBLOPAJHxDG|iI6QJDHPGdIRSToBXsBRURbnBAPFACJDCALDDEDDHECALCCDHECDHCCCFDFEAAJgBFEDDDEDDDEDDDEAEHAHEDCJAXNNFAFMFAHEHUAEDDCEFCLACEFAFIAEFAJKAGFYCEFACEDACMFGJGACFAKOFiBTANKFACfVFJJDPGHDDEAAFeVDVENCADFEDALMNAFIFAFCHCAILMFOtBKPAHGFKZKLOAMOCwBHICEHKP2BHIFMDACEFAAIFAAKFCHUCMCADIYgBAgBXY3BYJAjBULQFYJINCwDJFjBJNMAIFILEAKUCgBLOPAJHxDG|iI6QJAHVGZIRSTqBXIASLSHQPFHCLHFAHJFJJFNJHALJSGOHSCMHEPAPKFFEFDHGJAHRDFDFJAPELAFaVCVGdOTEPKNEAGTDDCDALCFCAAFCADHIPCJCAAJITIJQAKOCwBFIAEDAFKDULaAMDAHKCKFEAKJGFYQSIUMIEOFWVW3BYJAlBULQFWJKNCwDJFhBJPMAIFIJEAIKEOAaLOPAJHEtHDHLAIFJAIAAFINCZGVIEFEKEDCACCADCAECCDAAIDCCCFCCCDCDKHECEFACCFCAEJC1DyH|iI6QJDHPEVKZUTcPKFCDiBNEFGAQPLNKFDJCFTHNLLaLORELIAFKNAJVFARERDNEAEJMJAJEAItBEJCJCAAFERGFCNEHDFCAAHEJANGVCXKNOAIGDCECCEAuBFWFCHmBLcAKCCDMJGDWCIYKAaMCCEIGCIDCASXYxBYPAJIdMLQFYJINCwDJFhBHJAFODONGEGQCeLOPAJHJ7HELGpBGCFEGAAECADECMDACEFEAGFCAGHKAEFArD0H|uJgNMNFJRCAFENGLCbEADFIHAFEDKRAdENDLIfCAAzBEDFAChBKPQAAEKGC6BJWAgBJkBIEAEFMFAFaGKKAKEEMLMfFHEFMHCDIHGAEPALGvB6DJDHTKjBWXYPODIJIAmBRKJCJHDFNQDCFMAMIDQEEAIFIRQ3BYNCjBSNQFYJINCwDJDfJPODONIIGWAULOPAJHL7HCJGCFACEFACEDCEjBEADEGCJCDKCJAEGAHADE|oJkNCXGPKNEPUNMDADYLIXCJJNDJHFLDHLAjBHVDACsBCCCUGQTAHEDADFAXFHCJFJAhBDXCHANCZENIHQAKIAGEAAIIMEAAECACIEEDCEOAkBMIIMCKECAEEEAoBFEAMHGDMLOTIdGNQFOVCLGHCpB2DJDHTKjBUVYPQFIHIAsBVGHJPWFAFIFIGAEEIAQFIRQ1BYNClBSNQFYJINCwDJDdJPODONGEIaASLOPAJHrCxD|oJmNAPGPEJGFILAJGJqCbKVAPNPFJLFLANNFVAVLZFCFQAmBO8BDELEPIHRFAEJFJDACJFHAJHRCDDFAzBDAAREADbENIJSDECACEAEGCAGMWUDCGIGSAQEAFEEMQGCEMKGMCDIIESDcDADONSlBSjBILMNUVARKpB0DJDHTMlBSTYPQFIHIAsBVGHHJEDSFGHEAEEEIAQFIRQ1BYNClBSNQFYJINCwDJDdJPODONGEIaASLOPAJHrCvD|oJmNANGPcnBcNSDCDMFMDEFGDKVDRLJJNJFNARJFFFTFfJPJDACJGAsBS!BLSJALHFTFJAJHJCHDAFPAFFNDnBDJENDVEPMPQAECDCICOSGGEAEEEAEMIEDEGMAEEGAKCAAMGEIAIEQQGIEACEGEIQCYFAAIFKHKCEFAAEFCDElBQnBKRMNOAGVARIpB0DJDHTGRCNUZcROFIHIAsBTEFANIAGHSAEIAOTYzBYRETKTGNQFYJINCwDJDbJRSFIJICIaASLOPAJHrCvD|oJmNDDGVenBQLgBHuBRKRAPfdZDNJNZFdJNHFVAAoBMqBCADCMYAWDEXAFHCNDADHFFCDFDNfDTFHANDDALFJEDFHEbFAAHEFALCACLMLQAUOEISIOQIMCMGIAOEKQAKEGECEGCMOKEEIEAGMAcNUAGFCAEJIlBOtBKNGVWDEXANIpB0DJDHTIdSZiBTGAgCbEFDJEDIAADEAGHEAKECGAORWpDuBNOFYJINCwDJDbJPQDKNIAIcASLOPAJHrCvD|mJoNGXajBYPoBJwBRIVDPNHTRfFPHNXAJFADTHLJNhBNAkBEMDECCIcEGKYGCGaCADIPAPIHTCDDDADDACFFAFLADDANXALFDDLDACHFACFHJATDADJEAFFEfFAAHEAAPEAALMLSAgBaSIIKEAIOEMGIDEEQEADEaACEGAAEIAIIEAEIYMIOAaLSCEFEAENOVIzCWROJOXAPInByDJAFJDJCLEVYbgBTkCbEDDJODMLGCGIAQRUpDuBNOFWJKNCwDJDbJPSDINIAIcASLOPAJHtCtD|mJoNGXajBYPoBJIFMDYLIPCPDHLFLLPLPAZHLRFNCFFAANHNPNfNAkBCMKaIKAGCGEADCCAEKEEGYCADGLAJGLACFFHALHHFJCDFANdFRFFCDDDDLDAATFAAJCDDDAfDACDAFEFALCDDFEAAFKHCFQAEGGAAEGCGIEAQMICOQIOAGEICADEGUKAUEIEACICAEGCCGGCACUKGMCaFECCReNKRGxCWLMLKFGVAPInByDJAFJDJCLEVUZkBVkCbEFFHQDKLGCEEECASRUpDuBNOFWJKNCwDJDbJPSDINIAIcASLOPAJHtCtD|oJmNAJGVOPCHINQLyBLaNIPATJHHLHAJNZFLHPvBNJZDDgBEGGSOQEWCCAYNDJCAHFDAPNdAJHJCFFACHDAAFFJATFJEDFLCXDAAHCACFCVCAEHEAEFQASUWOIKOiBEYOCQIEGMKDCCEQKIOAYFCAGNYHCFGlCYTIHKLGFIVANIpB0DJDHTGbUZgBTSHKHQFOJOFENGDGJIAQGAEAQRUVINInBMFEfONOFYJINCwDJDbJRSDILIAIcASLOPAJHrCvD|oJmNEZOVEPIJeLMDeNEDAFIPDPHLLLDHTHJHHVFZJDRAJGAkBIOQMEMAGHGFORNAPP9BDlCCHAJCAINSFMKKQCAQQKeEeOGEGGEGKECMQEQAYFMFEAERSTIhBIACXONOAGXCRInB0DJDHPGdSbiBVIAYPODYLKNDJCFeECGAONShBSpBQlBQNQFYJINCwDJDbJRWHEJICIcASLOPAJHrCvD|qJmNARENKPATCFSLiBJQJGLDDEDAdJNAHNFDFJHDpBHDLCNMAkBMQQGCOFELCHIHCAJFNJtCAVEFAvBCACHGJSDMKAIIIAGECEIEACcCCCgBOGDEEEGOEEAEECAKESFQJYPQtBOLQNMAIVARKpB0DJDHPGfQXIHcRIAYPODWPEAIHJPcAEFECAGEEAORWPGTMlBMlBSNQFYJINCwDJDdJPWHELIEIcASLOPAJHpCvD|oJkNDLERKPAZKFEFgBLGFEAGFAREDAXFFALNHFLAnBNCFGDsBGIEAEEQCAOTAHGHADlBCnCCDCJCjBCNIJSDIKCIGIDCKSA8BKEDGEMEADGCCAEECDICMFWJYFIJEAEpBQNYFEDIVAPIpB2DJDHPGfQXIHcRIASNUFWPEAGLLJAFICaJECGOAMNUlBWlBKlBUNQFYJINCwDJDdJPWJEJIEIcASLOPAJHrCxD|uJ!MALFDFAANEJDLCNGFADEACFgBNKJDFEFEZFDDNJADNJHDZCFKDCKCtBGNCnBCDCJGFSDIGEQEEAGCCAGECAgBDCDaIIAYGIFCCGFAAQFSRiBPMLQLFPALgBTALEvB8DJDHPGdIRQR6BdODcREFAHJJAHIDiBKCONYpBWhBKlBUNQFYJINCwDJDdDDHPUHGJIEIaAULOPAJHV9HFDDFSCAGNAJNCNAMrBwE|iI6QJDHTGZMVMNEASNMFQLUFCDQJQNAHJJALRJNNDUHWVCNGCPFJJADDCLHLALEHMFEHEAEFMFCFCAINDdHNCTDPEAAIEESAHDCTCFALETCAARCHEADFCJEAAZEADDCHIJQAIGAGEADECCIYAQHgBCoBHkBHUJQFEHOFcgBSASHMVOZOrBObQNQFYJINCwDJDdJRWHELIEIWAaLOPAJHArHED1DyH|iI6QJDHPGdIRUVsBXODePMNJTVZAREPAHHQDANOEKAQJYRDPKCdJAJFAFJLALGJOJAFOFGJCVDZELDHCAAFEDDDEAEHGDWFAJDAAFCACdEAGdCAINETCADHMLQAEECGECDEEGCWCCDACIFEDWDCFQCIDEFcFACEDCFSFCAKJMAGDADGAEFCDMKgBKGCIGEAQHMXStBUJAnBUNSFYJINCwDJDdJTUFGLEAEGEKEkBLOPAJHPpGFHCRFJCTQDGJUJCPCDFRICEGGAFMCAAICAHAECFGECHEECHCCEHAEEJACCZAACDAAEDCHWpD6G|iI6QJDHPGdIRUVsBXMDgBRONbpBFZEJDJCCEHDHCCCFDFCFCCAFCCDJEAAHcAOPCLEAFFEAAHADDACPNNJADEDKFGAIFCACDETEAEFAAGFCCELIDAAEDDAGFACMDEDACEACDACCDGCKHMJECEGEEKFgBTANKFACTDNVFLNALOVIAGJGAALCDDVEFGVGFAFEAIHAHQRADMDQzBEAGPKJIZKHQAKOEmBPqBDMHMCEHGCCHIPkBFELeAIGEDCWgBCcHMZSrBUJAnBUNSFYJINCwDJDdJTSFINIIGOCgBLOPAJHxDG|iI6QJDHPGdIRQPADEAQNeRKAeRQNXlBFVAPEDCNMZWJEHCAELGDFDADGADHCADDEDEVDbCTNMFANUFMAQDIDAFGRCACJCdeACHMCIFCAGEAAQFIMIEIAMFUPATKAVFJZFLNAPEADFEDCHEAAFCAMNEjBMPAFEAAFOLEJMLGDCFODIZEADFCAAJEDADEDDDKREDADMJCJGDDDCDADCAAFMLQAIGCGCAAICCCeHKFOCEDCHOCEFCFQPcPWAGHEFODAFGCEDADGAGGMQaCeFIbUtBWLCbQFANMFIFYJINCwDJDfJRSHILIIGOCgBLOPAJHxDG|iI6QJDHNEbKVQTEAIHWLGHuBTSRDLRfDbGNAHCAIRMLKFKJSlBAJCDALCDATGVZULKNWCIFADMNMPAACDDPIlBeFaFGAKICACGCEGKEEEEKAWFCRCNIFFARDDHFdHNNANINEAAJINEdEDADCADFEDWZSLCHIDOJKACFCADFEAAFCADDEADFEFCHCADFEAAFOVKJCFKFUbGFQAKIGMCiBJQAKFCJcJKJWNMAEHIHEAIJILUAMEKOWAgBFIZUtBUJClBULKHgBJINCwDJDfJRSHILIEIYAaLOPAJHxDG|iI6QJAHNEdKVQTEAIJkBTEACDGAQJcXALRfAZWrBKFCHGAMNFJGDDDEAAHGDCFCAGPDHEDCNEJIbFATQLERSTiBCCLKJENADCNAFEJCFGJCJINIJGFcCKDGYGUMEODSTELIFDDVLDDDbDLFJNARGFCFCAAFCAARCACJDNELCAAHCFEHKDAFGDCFIDAFOHAFMHaJKACFCADFEADDGNEAAHEADFCAAFKJCHMLDDIDKLOJORIFQAECGEEOCAAGCAAcDEAEFGAEDACEFAAIDALaHEAGFCFMDADGTWHEDIHEHMFCCCLOEUCAGIEOCYDIZY7CsBNMHgBJINCwDJFjBJNSHILEAGEGUCIAWLOPAJHxDG|kI8QLFHNEZIVSVEAIJoCjBURALPjBARGTEDMXcdAFYdCJOVKbAJtBaPOPaRUNGhBCfQDEZKDQEcFIcCSIGGGQAQRCRKDZpBFRHJNAPKPDpBGRILeNCFcRoBHWlBYZmBXOPKFOAKGIQCeNiBjB4BlBmBTcCUIMEOAQFMXW5CsBPOHeJKJCsDJFlBJNSHKLGGKeAULOPAJHvDI|iI6QJAHNCXIXQVIDGJqCjBURALNjBANGRWhBcdADCFEAAFKHGNIJDDEDGNIJCJIRALxBYDEHCCCDDDEDAFEFCCCFADCAEJGAGFGACFCAEFAAELMNEnBCACJEFAPIFAAEPGJCNGAQCgBKEcCQGKKCIAURCFCAELCFXvBFTJHLDTCAADEDDhBGdQRaJKJWJCFqBFCFGAAHEDCHGFAHEACJEHYVgBPEHGAKLMJYAIEAECAAECAAEECAGCADCAWCEHMAGHGAGHGCEJGAGHEdqBLGACXSHMDAAEFCJKAWIOCIAUFMXW3CqBRQHgBJINCwDJFjBJNCFQFKNIIIcAWLOPAJHxDG|iI6QJAHNEdKXaZsBVKJGAgBXCNDDHjBGZQZ6B5BCFIJCJIFAFEDQhBARFADGDDHGtBURMVUAIHCAGFAHIDEHENELAHCbCbMHAAEDDACFAACHCRELICsBKEWAgBIMIEMCMFINALIFADDDLFJxBFVHJLFNA1BGNDFEDCHSNeLWPUHkBDKFCHEDDDCAAHIFAFGFGLcXUJCFKDMHMLMHUDGCGIECAEEECiBFMRcAEHEAEFCLSFADIPMAEFADGJEFGJEJMLGDGNMAUGYAQHQZY1CoBPQHgBJINCwDJFjBJRQFKNCAIIIcAWLOPAJHxDG|iI6QJAHNGhBIVYXkBRMHCFSHYTENDXDDAZGRafGDADQNADEFECDDcZDFUTAHEAKVGJDFEACJDNJEJIhBKhBSZYJQVQHEHDvBGTGFEDDPGFCCCFDAETEFEFDJGAcEMEE4BIQEKIIQCKHCACPCJIFADNLJvBFXHHJHAFTDACJFACJFRATITILMFCDWHADIAIJSFAFMF6BHMPDFIFKPiBbYNeLCHIDEHUDMCKIAEGECYCAAMHICEFAFMFENYDAFIPOFIJGFAFGCCHEDEFAACHCCELEDETMTWE2BJUXW1CqBNOJgBJKNCwDJFlBJNCFOFKLKICIGUAWLOPAJHxDG|iI6QJAHNGjBMXUTwBXCHKDgBXADEFD1BIPDDGFGLUTADEAMLGDADCAqBpBCFIFAHIFDDCAIREFAJIHFDCJDFJCFGJCACJAAEVGFDAELEDDFETIdYAGLIAEVQFAACHC7BEVIHADENCFElBMAUKagCGcOKaTELKFADPHH5BFdJDHHARtBAfEADDCFCADFEHSNsBNCFEAEFKAEFOH8BFADQPAHGDKNEAILEDIJGDiBTcJIHMFAFeDCCEAMQCYCAAMFCCEDAAGFADMHEFMHEDIZaDAAEDAHIHAVWHAHELOLCFILICCFCDAA2BLWZWtCmBRQJiBJKNCwDJFlBJRQHKLKKIcAWLOPAJHxDG|iI6QJAHNGjBMXMLILwBXCHKAgBZEFAzBCHCACLCACHOLOTCAEFGACFSNGJGAmBlBAHGDMVDDIHFDEDAFEADFCAANNCPIACFAACFDAEDDLGLAACLCXMLEDEDDHILGJKDDAIVQAEFAACFDAEFChCElCaVEDEDDASCADEEAEMECEKkCGYKIIGUTGJKFDDNLH5BFdJFHFAJPAFDACDFDADFFALFADHAfIRSNuBNKJiBL!BFMPCACJoBhBQHIHEAMJmBNCFIAAFcHOCOQEMAMEADMNWCCHEDEFEJOCCHEFGLITUHCLMHAHIFANIJKJCAEPMCCJCDSAeLcZUxCqBNQJgBJKNCwDJFlBJPCFKFMLEAGGEKGWAWLOPAJHxDG|iI6QJAHNGjBMXUVoBVIFAFMDcXGHCnBMdQTCAKPEACFKDONGDWVGDDDEASVEAAFEAMXIHGRDJAFNARKACDAHEFDACJAAEFDDCVEHGTGAEHAACFAfaCEHCDGJGFDDGLECCFAACFDDEFDJCvBCNGHDCCLAAEFAJAHGXGLEREFAFCCWGKGCAIEEoCGSGOIKMDIAEREDGHCFAFNNF#BFXJFHHAPTAHDACDFAAFDAAJHJAdIRUNmBJMFAFKFgBLkCFOPAFMJKNEAOPWNMDMJIAWLIAOLIFSDQCKIIMCUCADECIFADMDAFKACJGJMAGFCACFCJMHCAELGAEFCJIFADEFADGNGAEJCDEXOHADIRMHUDeJWZYdMlBWNGRQJiBHKPCwDJFlBJTADQFKLGEEIIcAWLOPAJHxDG|qI8QRFHLGjBMXUVAD8BfgBbGnBEJDFEAERcdkBVGJECCHEAGJGAKNGDGLOLEJQTIRDJFFLATMDAHEDDNGJAZIhBQNIDEFAbeDDPKACDAHEHDACJAJC1BC3BUFAACjBGDUEIMIEKMAUG2BCeOIMAEDEFAACJCLKFAJNJDpCHjBPHNJFHNCFFAFLDXGVYToBHUNgBJCDoCFSPELEDEAKNCAAFEAQNMFQLSFCDMFQFCDSHCFKAMHUCGCIGDEGEAECAACESAMDAJYLIAEFCLSFAAEbYHACEFCHCCEJAFGFAACJEFGPGLKJCVSACDALcDcJQZWHCpCoBPSJmBJEmDHFnBJPAHOFKLIEGOGYAWLOPAJHpDI|qI8QRFHLGjBMZcb4BdaZMpBDFEADFCAADCAAHGFDDCAYd0BdAFCCEFGJEAMPGAKPECORCHMNIPDPPAHGNEACHAACFDAEFDDCrBMnBQLMFANKCCRQFAPMNERAFC5BC3BUrBIAUEEDCWSgBI6BCaMMOAGREJKFALNzCHlBPFHHDDJFAPbDfINOPKFoBHSLqBNsCFYbEAINGAGFEJgBNIHsBNMHKAKJIAIHYAGCQUCOCEDSFCHSTUAEPQLGLMLCAGJCAEJAAGHALKHCDEfOLMNIAEDAJUHeJQXWVI7BkBPSJmBJEmDHFnBLVMFONIEGOGaAWLOPAJHpDI|qI8QRFHLGjBMbcZ2BfWTGJIhBGJDFKRabcTGAAFMFAFECedGAIPGAahBIVDAAJTCAEHAJGHAACFDPInBIhBQNMFAbcHANMLCDCRAFCPDLERDRChBOHDAEDDPGHAACVEJDAEJAAYaUOCGEmCEaMKMAGREJMFAJNzCHjBPVRJRDADHDAAbDAERMPMFCFqBHQJCDmBLCDuCFYbEAINGAONSJADSJyBPIFKAIJKAIHUAICKIEMCACMCAAMFQJMCEVUAENMDELGNOHADGJCAEJCAEHATQfOTUFAAEFCJSFcJQVUzCwBNSJmBJEmDHFnBLXOFILEAGCIOGcAWLOPAJHpDI|qI8QRFHLGlBOdaXEAKLmBVaZU1BQTCHEAADEAKNWLEFEDADEAEHGDCFEAADCCAFONMJCAAFGDCHGAMPAHEAEJGFGRDFCJRANKhCSbMTMAEHAZcHALMDAACFDJERAFC1BCJELAAEFDACFAACJEFDDEDDNEACpBIFSCAACEKGCMMiBI4BCcMECAMNGJKNJtCHhBNNLFAHJDARbAfIPIJQJiBHiBPWFEFuCFYbEAADIHAFEACFEAKJkBTQFGFKAQHCDSHEFODIFQAKEEGEAAEEIEACgBLQCCDGJGFKFAFIZWAEFAAEFADGHADGHAFCCEPGFGHCDEJGHAAELELEVUFACEHEDIFIJcNUFAPQJCROpBWTQHKHkBNIoDHFnBLZKFMNEAGEIQGcAWLOPAJHpDI|iI6QJAHNIrBOZUTIFEFOJADGDEFEAQNYXUxBKPEDAFCAEHEAMPMFEHCCMLGAAFWPGLMHORCCAFKHCJCDCAEJGFDFEDAFEDAFANPANKrBOJADCPEACFAXKLMFAACRIAEDACEFAHKHCFGFDLK5BGNDHCHAXKJCFAFEDDPGACFDNEJAACPCDWGKEACEMIIAcI2BCcOAEDAFGJEJKLFrCJhBLNLJDFLDALNAJFAAfKVIDAFIDCFoBHCDMDGHUFMHwCHiBjBCFGASREAIHMDMJUFCFWHMDEFQJaDMEOSEgBFADECEFAHSJGAEFEDEDADGbYHKHADGLCDELGHGFAAEJEHGXMFAAEVSDIDAAGFCLeNOAETQHCZUZMbWHMHiBJKNCwDJFnBNZCFKDMPIEIQIgBAWLOPAJHxDG|iI6QJAHNItBOXYXEAEJECEHIFEHKDcZDFKHGTGDAHCAAFIPAFUZGAINCCIJEAAFECaVEAEHGDgBhBMLAFIJAFIJAHEDARNARMLAZKJADCDAnBQFIFDNOHAPQAEZQAC7BGJDRCDEHDACNGfIFEJDCEfECaGIQIEDkBMyBCaMAGTIHKrCJfLbNXhBAhBCACJGJDDKDCFEFcFEFKASJoBPoCFkBnBEAGFKLUJADkBPkBLSNWDUGMQEgBHECEFADGFKCCLIFKvBuBFAVQACHACEFAAEHADERGACHEFAHIPMCEJEDKFCAGLWNMAGTSHAVSdQROPUHiBJKNCwDJFpBNZCFKDMPIEISIgBAWLOPAJHxDG|iI6QJAHNItBObYXGAKNKFCFKFKLQLDFKHETGFKZOREJSPADEAIJEAGJCCEDabGDQVQNDFORALEDARJADENIHAJELCDCJAtBWVUFAHGHIAETOHCCCHDAEJD9BGNEAEDDDCDADCPCLIDDDClBMDSGECGOIIAAEWG0BGaKFGJENOvCNRHZNPXHDDpBGFAHGJQJcHAFKAADKDCFYHMHiCHgBlBEDEAMNWNGAAFIFwBRWNYDGEEAMSCcCADACEFEAEFEDKDCACHCCEJICEHCHKFAbgBJCJKJEDEFALMbOAEHCPSTqBNMAENKFGHATUZMdcHMHiBJKNCuDVDfNZCHKDMPIEIUIiBAWLOPAHFDDDNvDS|iI6QJAHTInBMZSVWRCFKFCHQJILGFCHIHEPGHGRSZCHMLEJECEHIFINcZDDCFKHGNGFEPCACHEDCNCAAPJEHIFAACFDJINClBSTQFKHCCEHCAGTOfIJDFETANIDAACFDFEFAACJAJGhBQDQEECEECEEIAIGGAGGEAACMAEIaDSGECAIFEPEHITDfNZDbPRTAFFDCFFACFDAAZENMNOFGJGACFGAUNGAkBPoBFahBGHEAADQPOHGHwBVAFKFCFYDMGMWAWDACEFGACDCAGHKFCCEHEAIJGVcHEDEFAHKHCFIHCCEFEFADEXQACLKDEAEHECEFARkBXcJCACTSTITUJGJQJoBHIPCwDJFrBNfAFMDKRIEKYIkBAWLOPAJHxDG|qI8QRFHNGnBGPSfiBdCFGDCHIFVRDNGAQJeAKXUjBQTEAKLKRQTUfCNGJEJDJFEdMFGRIXYAGFALSNKLCACJAACZCRIJIFDPGXSDSCEWMIADCCCHCACEADGCKdEdXJTAZEADFCAAFELONEAAFOLOJGAGFYNkBFDFIHAFGDCJEDAHKFKPQPMFAFEAEFGAOJAFQNYACCEACEECDCECDCEIAaFSHKDKJIAELOHMRQVcPKHIFILODIFEFMHIFMLIAEPQPKJKLEPMAEPMAEJILwBNIoDHFrBPnBKDOREAGIMkBEYAWLOPAJHpDI|qI8QRFHPIrBEFGTOPCHmBlBCJEDDJEDCHILEAEFMJCJObGPMNAJIDOdMLQlBAJGHALPGRQNQJOFEFOJGACRGHAACHCLAAEDDHCLMVILSAQKKIAEELIAILIACJARNJNCDDAAFFJAZEAAJGNEADFEDADEDDFIHUJKNGACHQDAFUACLCAADEFAFCADDGFAHGDMVUPDDGDAFEAMJAHMLWAGCEGCAEMAYDKDCCIHIFQHIDKHEAKRQDIFECCFADIDAAGFAHKNKDMFEACDADGFECEFCFOJIDKRSAERKJOHAPQFGNKAEJIN0BNIoDHFtBJbFAALFDCFKAMPAFICEIAIMeEYAYLOPAJHpDI|qI8QRFHPItBGREJQRAFmBlBOJAFMNCHGHERCADDCDDJIdORAJEAGRObCLMlBHGLWFCAMTeHALGJCVWHCLoBKECENIJSHAJNJFFPEZCDDHEADFCAGRDFEDAFUREHEFILIDGFIADFEAAHCAGVEFCHCAADENOPDDEDADEAILAFINUAICEGEMAiBFCEIFACEDAJaFCAKDACEFAAKFACEHCAGDADGDCAEJQCEFAAENMHUCCFCEUFIDEHEDIPMJMLEJIDIFARODIPKAEJKN2BNKoDJFvBRtBKAOPAFIGEIAEEMIUEaAYLOPAJHpDI|qI8QRFHPGnBKbSZCJONUZWAAFSVFLFAAFHFACRIJUHAJJJXCHCACHSVELCADJEJAFEDDDEDDFEDGVGNGJAHCAANEDDDCAAFELADCADHEREFAHERKNQAKOASCaDAAQJQFgBFGJaCMDIJEDWCIEEEAGGQEAKRSNEPOZGNQFAJIFMPMAELKN6BNKoDLFvBPtBGDGNGFEAEIIEMmBEaAaLOPAJHpDI|qI8QRFHPItBQnBCAMVMNADEAMVHNCPFFALEAAFUbChCCNAbEAATERAfMPMAMKOqBCaFIAKAKEADECCAGCADMEAAUAEIEAOFAAEAaKOEACCMAEEAIJKFCJGVGFGNEKCCCAKDEFEAEIKMsBCsBLORAHJFxBNpBDDEHCJCACHCLXLJKJMHEHONKDILMN8BNKkCzENPIRGNEDKEIDEMTUDKDCFDaxCDAAZGMAKFAhDkH|qI8QRFHPKxBQpBEFIRMLAFKPARGJDVGZFRFACFFFDRDADFJ5BEjBAbKTUFIEIKEACEGEAEGAEIECGKGEAIGIDCEEAOEQWIQYGAEIIAEICACOFGEEAIFAFcIKAGNOJGNEdELIEUDQEGKmBCuBLOTDHLDtBNvBDDCAEbJPAFGRONQHcDDPCAAFETARVVHJJAJJLFDFFDCDFFDFCFFACHFZFFAHPRFAFDDiBGwBCECACQGEDEEICQAQFKDSHMAcJIFIDAf2BN6BNK|qI8QNDHFFNK1BMfQfKJCLEDKdCAAFCADbDJbjBFNDADHFFR1BEnBDTCLEACJGACFUDaSeMSQAEEAEMEAAGGEAKKUYAOEYQQEAEEAGAGIGADEGECYCENeHCJUPORIvBEHCFGDkBMuBCuBLOTDHLDvBNxBCvBGNQPYHYAOFCFADGFOVGNDLVHbVPCZFFFJAPZCFFACFFJAJDAJJCFFALNdJAFNJAsBCMSiBAKEADCIGKMCICAACEMEDDGCAAKEAAcJcxB0CPgCLG|qI8QNDJHDJK3BIdUjBGHCJEFMhBCDDXFFFJJJNRDADHFDDJLNHTFFLdD7BCJEDAFCADDIFEFUDSKCEEAACoBOQOGCCECADCEAEKEAIKDGEIKQcASESIEEICKGGAAEQEAEGAKMCADIEIAILcHELQTQdMtBCLEFGDkBKqBCwBLOTDHLDvBNvBExBEJUTWHqBDMHCFIAGNKLETHFHADFFCCDNHFCCFFCADJFHFLFFACDhBADDJAPFJJHNCFHJFNPRHALJAFHAADDCAFHCADDAPFDFFAPLAkBCMKUEMIIDCEECIQOAEGCDEIGMWEcJgBtBuCNiCNK|mI6QJAHFFLK3BIdgB3BInBDPHJAFJFFJZXJNFDAFDAAFDAAFFDAJJJAFDAAFFFCDFDCDFFDRDDArBCLGFDFIFCFKDQAYO2BUMKEAEGGCGKGEEMEECGCAGMuBCiBMeQKAAEKCOKIQDMAEDCAGHQNKLOTMlBM1BENGFKAcMyBAoBLOPALLDzBLtBCjBIXKNSJgCHOHCFKAWXETNFHADFDCDFXHDFJAPJ7BFJFNNCFFAAHLNFLPRLFADFCAFJACFDAHAPFAFFCADFADDHAADNFNJAiBEOKQGQKICKQOMMCADEMIIQEUCAHsBpBwCN!BJKJA|!H6QHFFJI1BMnBavBIhBANFDDPDAjBjBJDPVHFHJAHFDAHHDJRCDJVAZFACVCAAHEFAFEAAHEAADKHWAeQqBMQGEEKEDCMGEEMKOYGCDEGEDC2BCUEEEUGEEOECCMCCCcKIIEIDEEAAQFEAGFEFKJGRULEACPIpBK#BELIFMAYKmBC0BLOPALLDzBLtBClBIVONEAKJkCFkBNMHQTERZJFCADhBNNJvCHPLDJDADHNPFLHHJFFHHAHFDCDFDCNHZHDDDADDFAADVJDFLAAkBEAEUIEQcEAEISOgBiBKcFsBlBsCNiCJKRA","officialShapes":"iG4DUGOMaMkCUgBUYaISICwBDWE2BWgBGYDQKEIAOVeJGLOfWnBMvBGnBALCJGDgBMuCDkBbAHHCLFxBL3BCZGTSVKFoCFgBHqBXSVFHNAVH3BXXFbAhBGLDJHHTLRTVtBVhBHtBVHADKCYMaSUEIcYQKaYSiBAMHUZ0BLcLqBHsBZDHJMtCGVgBnCCNDLLR5BvBZbRXPnBAbEVOb|gG4DMAeWSI8BQaMiBeKQCKICwBDWEiCYUEkBCKQAKJQTWhBelBQhBG#BCLCJGFIAWMuCAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTGHEPNAfJlBRVHlBDhBGLDLFPlBNPhBTnCVRLRHDKCYQiBmBoBmBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXnBbhBhBbnBLpBAPGhBKR|gG4DMAmBaKE0BMiBQWQMOKQCKICwBDWEiCYUEkBCKQAKJQTWhBelBQhBG#BCLCJGFIAWMuCAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTKPDFpBLlBRVHlBDhBGVHPlBNPhBTzBPdLJHRHDKCYQiBmBoBmBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXtBhBbbbnBLpBAPKpBGJ|gG4DMAwBe0BMiBQcWamBWFaAWEgCYWEkBCKQAIFKVejBebMVGtBGnBAVGFKAYMuCDkBbAHHCNFvBL3BCZGTMPQLoCFsBJYPYbFHXDTJNDjBRjBFPAhBGLDJHLdLPPNtBVhBHlBRHHJADYGUOYkBoBsBgBMOMaDYnB6CFWFIFuBFKZDHHMvCKdY1BGVANLRXRxBrBXdRlBFVEjBGVIH|iG4DUGWQSI8BQSIcWSUISGCyBDWEqCcmBAQKEIHUdkBVSZOTGjBG#BCLCHGFKAYMuCAaFIbAFJCNDXN7CEXKRGHcL!BDgBHcNaZEJHFNAVHhCZZDvBGLDHHRlBdZRJ9BRjBTHCDMGgBOYYagC0BKQGSDYhBmCNoBFiBJeXFHHMvCKdc9BCZHHFLnBbbZZdPZLpBAPEXOZ|iG4DMAeWSI8BQSIGGKEUSSiBgBDkBCqCcWEYDKCKQCKVgBTUfWTIVEjBGzBALCJGFIAaMuCAaFIbAFJCNDXNvCAPEVKRYPqCFqBJYRYbxBNlBRVHXDlBEJELDJHLdhBhBbNrBLzBXDYOmBKOIGEIiBeKEaYOYCMAMHUZ0BPmBLiCHIVFHJKjCQxBSjBKdHVbZLFPNnBnBbzBFlBEVOb|iG4DMAKEMMkBQoBKkBQUSIESiBIEWFuBEUGsBUWEkBCMOAMPYZaXStBS7BGnBAJGFIAaMsCDkBbAHJCLFvBLlCIfUTUHqCDoBLWRSVFHNAVHhCZzBDVGLDNPLdbZbNrBL1BZCkBWqBSU!B0BKQGUDYlBuCHULiCFIXFHHMvCKdgBnCLdfXpBlBFJTVNbJfAPEXOZ|iG4DMAKEOMiBQqBKiBQiBeOaIEuBDgBGiBQeKsBCOMCKTiBTUfWbMhBGrCCLEFIDYMuCAmBbAJFCNFvBLlCIfMPQJWFMCwBDqBLQLUTEPhBHbNxBRbAhBGLDPNHVLRdXdNhBHtBVHHFKAMEWISWcwBqBQKQWIeJeXqBPmBNuChBDIlCU7BWrBEVPb5BvBjBrBNbFXClBOb|qG2DKCOMYOyBOsBUiBeMcSDyBC0CgBsBCIGEIAMFKRWTUfWnBMlBEzBALCJGFIAOM6CAaHGbADtBLlCAjBOZQLKDqCFqBJYRYbhBHhCbXFbAhBGRLDLNbVVjBRrBLrBXFEDYKcWe2BwBIEMOGIIeFWlBuCJeJ4BHEXDFLEjBM1BgBnCGVHVNPfVNPJFZdXrBHhBCNIfEJIH|qG2DUGOMiBQyBOoBYYcGSICkBDqBIsBUgBIkBCGGEKDSXebYLEHGTItBIlBCZDVEHUM6CAmBbAJHCLDlBL3BAnBITONSJ!BDsBHiBTYbrBLjBRfLXDvBGRLPlBdZbNrBLjBRHHJCCkBMaQWUUyBmBOYEWFWhBmCLcLkCHCZDDLEjBM1BY3BKRGTDNJRfXjBfFJJHRXNbHhBAPIfMP|qG2DMAWSiBQWEuBSGGKEUSSgBIGiBFqBI2BYgBGWAIEGICKDKRYTUnBaJEtBIrCCJEHIDKM6CAmBbAJHCLDlBLlCAZITONSJiDFUHeVSVXFdLtBVXFbAjBERLDLNbNPrBXzBPbNHHHEDKGgBUgBmBmBYQMMOYGUFWbyBPmBJeHuBFIXFHHKlCU5BWrBEXJRtBjBlBpBRXJTHhBAPEVOb|oG2DMAKEmBaoBK0BYGIOKYoBkBFqBIiBQeKUEaAOMCKDMLOfiBXQTItBIrCCJEHIDWMuCAmBbAJFCNDlBLjCCZGTMPSJKDgCAiBFiBTUTEJXFpCfLDnBDjBEPLPnBVTtBVXFtBVHHHCCkBMcciB4BuBKQKcFWbyBPmBLoBFiBFKXFHHKjCU7BWpBEXJT#B1BTVPZNdFjBEXOZ|mG4DIFKCmBaSIoBKqBWUSSiBIEyBDIEWE0BYWEkBCGGEKAMHGFKfgBXSbMhBG3CCLQMmDAaHGbADvBLjCAbGTSVKFWF!BAqBLYPSVDHrBLtBVVFNDbAVENDNNDNJTbZjBRhBJzBbDkBQiBQWUUkBaMOOYCMDWLcXqBLcNuCZDJFANOtCMbCLWrBGVDLLRfXhBfNPZpBJfANGjBIR|qG0DMAKEMMQKSI6BSYOUSYoBMDwBC0CgBkBCSGGUFKRWpBkBbMhBGjBE1BAJEFKAMM6CAaFIbAFJCNFvBJtBClBITMNeJgCAgBHiBTONGPjBHjBRLDJHVFnBDfEPLLfLPPNtBVXFzBbHCCkBMcciB4BuBSiBFiBhBmCLcLiCHEZDDLKjCGVoB5CLdXRpBlBdlBNbHhBCZGVKR|oG0DMAKEUSaMyBOoBYSUUgBwBDWEgCa2BIKEEIDURWJGFIJEHIPKlBQLCjBE1BAVGFIAOM6CAYFKbAFJCLFxBJrBAlBIRMPSJ!BDsBHaNiBfrBL1BZXFbAjBEJFHJLdTVhBT7BVhBTHEDKCYMaGGEKSUIEMOQKaYMaCMAMLcPYX4BLiCFIXFHJKjCQxBazBCVDLHJNNZRnBnBRXNbHVAbEVOb|oG0DMAKEUSIESI6BSQKWQWeCKIGsBDgBGgCauBEKEEICMPYZafWTIrBIrCCJGFIAaMuCAYFKbAFJCLFxBLjCCNIRSViBHyBAsBJYPYbhBH3BZhBHbAjBEPNFVRZXRRJ9BTRJPNHIDKGgBeuBiBeeWOYGUFWlBuCJeJ4BFIXFHJMtCW5BKPKfFVHJXRvBrBXfNbHhBAPEVOb|kG0DMAKEOMYOcKUEcMkBcQWGSWFwBEqCcUEWASICKHURWjBelBQVEXEpCEHIAYIsBEoCNCXDCNDlBNtCAPGTMPQLWF!BDgBHgBTSVHF7BTbNXFbAjBEPLHVXfzBbXFzBbHCDYEWEIKQeiB4BuBMaCKDYlBuCHULkCHGXFFJKjCQxBWrBGVDLLRVTJFHJJFbbfvBLpBAPEVOb|mG0DUGOMYOoBKsBUcYSiBGCyBDUEsCcsBCIGEICKFKRWbaPKlBQhBG#BCLCJGFIAWMuCAmBbAJFCNFvBLlCANMbWRqCFqBJaPYbdHhCbjBFvBGRLPlBdZbN9BTXRHCDYEWOYkBoBOMKEaYKQGUAMHUZ0BPmBLiCHIVFHJKjCU7BOZIfHV#B1BZdVhBJrBAPKdKR|gG2DMAKEcWKEkCUgBUYcIQIGiBFqBIiCYMCWDUGGUPYfiBhBUTGtBI#BCHGHUMuCCwBZCLFCLDlBNvCCZIRONKFUFoBAsBHqBXSVHFpBLlBRhBHbAhBGRLPlBdZbNrBLrBXFADYEUSiBSUWQGIeUMOKcAWZ0BV6BLiCZDHHMvCGVc9BGVDNJRfXpBlBTXPZHTFlBEVOb|iG2DKCwBekCUgBUYcIQICYDkBCsCaWEWDKEGGEKDKPYTUdYbMtBIxBCXEHGDMCYK0BCYAaFIbADJHnCJrBAbITMPSJyCHgBJeVSV#BRbNhBH7BGJFHJHTRZPLlBRzBPhBTHQGgBUgBgBgBsBgBMOKcDYZ0BDMNaNuCHCZDDLI5BIfQlBCLGJMnBJTVTLFjBfZbbzBDNClBKdIH|8F4DMAwBe8BQaMiBeOYGEiBFYCeIuBSWEWDUGGUPYfiBXQTIfIXE9BEJEHIEuBIsBCwBLEZDCLDlBNvCAXIRUVUFyBDsBJgBTYdXDpBNbNXFnBAVGLDLFHHLdTVjBTrBLdLHHTJDYEUISkBqBIEUSKEaYMaCMFUjByCNgCDYZDJFCZMhCiBzCCLDNJR9BtBZbVhBHTFlBGhBKR|!F4DKCeWcKqBKiBQWQMOKQCKWFmBAWEiCYWCYDIEGICKTiBZafWdKhBG9BEJEHIDYK0BEkBAYHIbADtBP5CEXEJSVKFWFwBDqBLYPONKPHF9BRTJhBH5BIRLHTRZXRlBPhBHlBRHHHEDKCYMaeiB0BmBMMSiBFiBVsBRwBLiCHGXFFLKjCMnBY3BEXJR1BnBbZTXJRNdDlBIfEJIH|4F6DMAeWcKgBGcKaOUSSgBsBFiBE4BUiBGWDKEMOHSbmBdYbMVGhBG9BEHGFKAMMuCCwBZCLFCLFxBNhCCZIRMPSJ8BF0BNQLUTKRjBFlBPrBLbApBGLFHHHVLRnBbnCTjBTDYEUUgBgBgBmBaUSMaCMAMHUVsBRwBLiCZDHHMvCmBnDJTNPZPxBrBbnBLpBAbGVKR|0F8DMAKEeUoCSaMWQMOOYICuBFgBGSIyBOkBDQKEIAKTgBTUdYTIfItBGbAVGFIAaMgCCyBJEZDDtBNjCDZIfUTUHwBDsBJaNUTKRxBNlBPXFnBAVGNALFHHHVLRXRjBRtBJrBXDWIgBQWYauBgBUSMaCKAOHSfoCJgBH4BZDJHMtCMpBQjBKfDLLRvBfbZZdVtBDZGhBKR|4F8DUGOMQIgCOiBQWQMOKQCKiBHYAgBGcMoBKkBDOMEKDKbmBNOnBaTGtBIlBCXEJEDYO4CAmBbAJHCLFxBNhCCZIRGJQLUFyBDqBLgBTSVELtBHvBTXFlBCVGNAPNHVZbbPTHtBJrBTDKKqBQWaa0BkBWeEWLoBZ2BLoBHuBFIXFHHMvCiBzCEVJTHH9BtBlBpBRjBFXEjBGVIH|0F!DMAoBYgCOiBQeWKOISeFaAgBG6BUWCYDQKCUJQlBqBXQbMtBI7BEJGFIAaMgCCyBLCZDCLDlBPtCEjBKRYP8BFsBJYPgBhBFFtBJlBPhBHlBCVGNDNNDNLRVTjBR3BLjBTHGCYCKOYYciCwBMOKcDYNaDKHIRwBNsCXALFEvBKrBepCGVDLLRfVjBfJFZdLRJTFVAbIfGJ|yFgEMAKEGGkBQ0BKsBUWSKOISuBHWCMC4BUWEiBAKCGGEKHUVePMFIXQdMrBI9BEJEFKAMMuCCwBJEZDDvBNhCDZIfUTUHwBDsBJaNONQXFFhBH5BVNDnBAfILDJHXrBRLjBR3BLjBRFGEiBOYYaQKGImBYSWIQCMAMHUfoCNgCDYZDJFANOtCepCGVHVNNZPdZJFfjBLRJTHhBANIfGJ|6F!DKCoBYgCOiBQQKSUOWsBHsBI4BUMCkBDIEGICKDKVgBnBmBvBSXE9BELCJGDYO4CDkBbAHHCNFvBNjCEVITGJaN8BFqBJgBVWfjBF5BVXFbAXEJENAPNNbVVjBRtBJ1BVDMEUSiBmBmBgBUUSOYGUJeZ2BNmBHuBHUXDHJMvCepCIfDLHJVTZPdZZbLRNbFlBIfEJIH|6F!DKCgBU!BOcKgBUOMSgBUHmBAgBGuBSWEYDUGISNaRWjBeRKTGtBIzBCLCHGFKAMO4CAmBbAJHCLFxBL1BCnBIRONKF8BF2BLeVEJIHEPhBHVHbNhBHbAfILDLFXrBXRTJfJNApBNPLJCEiBISkBoBOMgBUUSQiBHgBZ2BNmBLkCHCZDDLI5BIfOnBKRMnBPZ3BlBhBhBRXPnBAjBKdIH|6F!DUGOMcK!BOaMcYKOISgBHaAqBKaMUGWCYDIEGIEIDMJQlBqBXQTIfIjBEnBALCJGFIAOO4CAmBbAJFCLDlBNjCAbGTSVKFWFwBD0BNWRWfjBFjCZlBDfINALFHHHVhBhBbN#BPlBRCkBISKOgBgBuBgBMMSiBDYHSd!BHULiCFIXFHJKjCMnBc#BCNJRNPnBbjBfbnBLdDZKpBIH|kG!DKEWQcKsBISGgBUOMSgBsBFYCUEkBQUGWEWDMCGGEKDSRYnBmBZOXEJE1CGJEHIDKCYMuCAYJGZDDtBNvCEjBSVSJoCFqBLQLejBnBJjCZnBAXEJETJRlBVTbNVHrBJdNHHHCAaWqBgBgBmBaUSMaCMDWnB6CNuChBDExBKpBKfY1BEXFJTVLFlBdVTFJJHLPNbHvBKdMP|8F8DMAYQaMmCSgBUOMSgBUDyBCmBMaMiBGWDKEGGEKHSbmBdYbM3BKzBCTGFWO4CAmBbAJHCLFxBL1BAbMbGJSJUF!BDgBJYPYbAHhBHjCZlBDpBGLFHHLdJHFJRLbN1BNtBVAWEUOamBmB0BmBOYEWJehBmCNgCDYZDJFCZMhCOnBSjBGTAPRXZPxBrBbnBLdDZGhBKR|iG6DKCYQaM0BMiBQcYSgBgBFiBEoBKIGcKwBCKEGGEKDKVgBTUnBaTGjBG#BCLCHGFKAWMsCAmBbAJHCLFxBLjCANMbONUH!BDsBJeVSVFHpBLbNVHXFbAhBGLDJHHTRZXRbN1BNjBTHCDKGgBUgBoBkBYQUSQiBDYhBmCNoBJ4BFIXFHHMvCOnBY1BCLHVNP1BnBZbVhBHTFlBIfEJIH|gG6DMAKEOMiBQgBGmBOkBcKOISGCyBDgBGiBQeKwBCKQLcTUFIdYbM3BK1BALCHGFKAYMuCAaFIbAFJCNFvBL3BANEXKRGHcL!BDsBJYPYbHFpBL3BXnBDhBGLDPNLdNPRLbN9BRTJHHJADMGgBOYYagC0BOYCKDYhBmCNoBFiBJeXFHHMvCKdc9BCVJT7BtBZbRXNdFVAPGhBKR|kG4DUGeUcKqBKgBSgBgBISIEWFkBCqCcWEaAKCGGEKAMLQXclBcTIhBGrCETGDMCkBKiCAaHGbAFlCFLHtBCZITMNSJ!BDsBHiBTYbzBPlBRVHnBAVEVDHHRlBdZRJ9BRjBTHCDMEUGUKQmBmByBoBMaCKDYlBuCHULkCHGXFFJKjCQxBWrBGVDLLR#B1BZdPZLpBAPEXOZ|iG4DMAKEOMiBQqBKiBQWQMOOYIGiBFqBIcKIGmBMiBAKEEIEKNaZadYTIfIhDGFIDYKiCCyBLCZDCLDlBNvCGhBSVKFWFqCDeJeXKPAHhBHbNxBRxBCLELDPNLdTVZPnCVjBTDWEWOYeiB4BuBOYEWHUhBmCJeLiCXALFANMhCQxBWrBEXJT5BvBZbRXNdFVClBOb|oG2DUGOMiBQyBOSIWQSUKQCKICwBDWEgCaWEYAKEMOHSRYTUXQbMtBI#BCLCHGFKAMM6CAaHGbADvBNvCCXITONSJKDgCAgBHaNGJOLIPrBLjBRVHXFlBCLELDRLFVLRVTlBRzBPhBTHQEWMaQWUUyBmBOYGUFWhBmCLcLkCHGXFFJKlCYhCKRKdDNJRPNLFvBrBXfNbHhBAPIfEJIH|kG2DMAKEOMYOoBKsBUQKSUOaGGWFuBEsCcUEMDKCKEGGCKDMRWTUfWbMhBGrCCLEFIDYMuCAmBbAJFCNFvBLlCIfMPQJWF0BAqBJSJiBfJHNAVHjBRfLXDvBGLDNPDNPZdX9BTxBZDYEWSgBgBgBsBiBWqBAMHUhBmCNoBFuBFKXDJHMvCKdgBnCANJTtBjBhBhBRXRjBFlBEVOb|qG0DUGUSIE8BSqBWeiBISGCkBDgBGsCcsBCIGEICKPaZafWTIrBIrCCJGFIAaMuCAaFIbAFJCNFvBLlCKdMPcLYCkBDqBJSJiBfpBN3BXXFnBALENAJFHJLdbbZPzBPrBXFEDYOmBMMKQiBeeWOYGUFWlBuCJeJ4BHIVFHJKjCQxBWrBGVLdfXjBfFJJHLPPbJfAbIfEJIH|oG0DMAmBacMUEcKQKWQSWGSIGWFiBEUEgCakBCUGGUFIRYpBkBbMLC5BIpBATGFKAMM6CAaFIbADJF9BLjCKdMPSJKDYCkBDsBJYPaZfJhCbXFbAjBEJFHJLdZbbPzBPbNPNHGDKCYMaWeaYYQYaKcFWLcHIVsBLoBHuBFIXFHHMvCOnBMbGHKdFXNPfVhBhBXfNbHVAbEVOb|qG0DUGUSIE8BSaMWQSUOaGCkBDsBIiBQeKsBCIGEICKFKRWTUfWdKhBGrCCJGFIAaMuCAaFIbAFJCNFvBL3BCZITMPQJsCDgBHiBTUTEJ1BNlBRVHnBAXELDJFHJLdbbjBRXFdLhBVFIAaKcWeoBkBQKSUGIIeJeXqBLcP!BDYJCXDDNI5BMnBc#BGVDLLRRLdZhBhBLPRlBHhBCNIfEJIH|qG0DKCWSQISIWEcKoBYSUMaICKDwBCsCcUEkBCKQAKPYZafWdKhBGrCCJGDYM6CAYHIbAFlCL3BCZIRMPSJ!BDsBHiBTSVCHrBLjBRVHXFtBGNDJFHJLdTVhBTzBPrBXFGAYCMMakBoByBoBSgBAahBmCLcNuChBDExBKpBGVQlBOZEXPZXRvBrBbnBNpBClBMbIH|kG2DMAKEUSIE8BSiBQWQWeCKGEwBDgBGsBUUGsBCOMCMTgBJGLOfWTI1BK#BCLEFIAaMuCDkBbAHHCLFxBLjCEXEJSVUH0BAsBHqBXSVHFpBLlBRVHlBDhBGLDJHPlBNPzBbXFdLRLRHDWEWOYQWmC6BKQGUDYHSXqBLcLqBHsBZDHJMtCGVkBxCFVHJNNLFvBrBdlBJTHhBAbGVKR|kG2DMAWSiBQoBKkBQiBeKQCKIEyBDWESGIGwBQsBCIGEIAMPYTUdYbM3BK1BALCHGFKAYMuCAaFIbAFJCNDXN7CEXKRGHcL!BDsBJYPYbzBPlBRLDXFbAVEVDHHLfLPXRdNpBLrBXHCCmBSgBeiByBmBKQKcAOLcLQZgCLiCHEZDDLKjCGVgBnCGVDLLRzBnBVVblBLfFjBIfKR|mG2DKCmBamCUoBYSUKQCKMCiBFqBIkBQUGUEaAQKEIHURWJGFIJEHIPKdMrBIpCEHIDYKiCCwBJGZDDtBNvCCZIRMPIFWF!BDgBHaNGJIFQXZDrCdNDnBAfEJFHJLdTVZPvCZXRHIAMEWMaWccYQKaYMaCMLoBTiBRwBLiCHCZDDNI5BMnBgBnCCNPZXRvBrBTXJRNdDlBIfEJIH|gG4DMAKEOMiBQqBKiBQWQSWIQIGWFuBEqCcuBCMOCKVgBZaXQTIfIjBE1BAHGHIDKMuCCwBLEZDCLDlBNvCCZIRONSJ!BDsBJgBTSVAHhBH3BXXFnBAVGLDPNHVLRVTbNrBLzBbDkBMaKQSUgC0BOYEWFUlBwCNgCDYZDJFCZMhCOnBSjBGTAPFJTVLFPLHJJFrBxBFJPnBDZEVOb|gG4DMAwBe8BQaMiBeKQCKIEWFaAWEgCYWEkBCKQAMLQlBoBXQfKhBGpCEHGFKOkDDkBbAHHCNFvBL3BCZGTMPQLoCFgBHqBXSVFHXDtCdXDvBGLDJHJRDNZbtBVhBHlBRHHJADMCWWqBgBgBmBaSUISEWNmBLQDKHILcFWFIFuBFKZDHHMvCYhCKRGVANLRtBhBhBhBRXRlBFVAbGVKR|gG4DUGOMaM8BQSIGGKEaYMaICKDyBCUEkBQUGWEWDSIEKAMFIXejBebM3BKzBCTGFWO4CAmBbAJHCLFxBL1BAbMbGJSJyCHgBJQJcZEJDFhBHvBTfJbAhBGLDPNLdNPrBXrBLrBVHADYCKMaQWUUmBaUSMaCKFed!BNoBJ4BFIXFHHMvCOnBY1BCLHVNPZPdZZbbzBFlBEVOb|kG4DKCWSQI!BQiBQcYSiBUFkBAoBKaMUGyBCIEGICKDKRYZafWdKXEzCGHIDKOmDAaHGbADtBNvCEjBKRYP!BDsBJaNgBhBrBLvBThBHbAVGNARLDLNbXTjBRhBHfLXRHUEUSiBSUiBeYOSWKcLoBPaV4BLiCHEXDFLKjCGVgBnCEXDLHJzBpBnBnBbzBDnBEVELON|8F6DMAKEOMiBQgBGmBOGGKEaYOaGCiBFYCeIaMUGWEYDKCIGGSJSRWVUXQlBOXEpCELEHUMsCCyBJEZDDvBNvCCXITGJaNoCFWFqBXYdjBFvBTfJnBAVGNAPNHVZdtBVzBPbNHHFKAMEWISWciBeYOUUMaFiBLcLQDKNaJgBFuBFKXDJHMvCU5BOZGVHVTVhBVbZNPZpBHVDZEVOb|!F6DUGOMaMqBIcKmBaSWGSgBFYAqBKaMUGWEWDMCGGEKAITiBTUJEVSTIfI1CGJEHUMuCCwBLEZDCLDlBNvCCZIRGJQLUFqCFUHgBTSVCJrBJvBTXFnBAVGLDPNLddZbN1BNjBTJADKCMEUISYcaYmBaMOMaFiBhBoCLoBHuBFIXFHHKlCMnBc#BCLHVVTLFNNRLbbbnBHTFlBEVOb|!F6DKCYQaM0BMiBQQKSUOaUFyBCiCYWEiBAIEGICKDKLQRWjBedMVEjBGnBAVEHIDKOmDAaHGbADtBNvCAPIfONQJ0CHeJYRYbHFNAfJvBTXFlBCVGLDJHRjBVVjBR1BNjBTHCDMCWSiBSUWQGIYOUSKQGUDYNaDKLQRwBLiCHEXDFLKjCqBxDJTHHvBhBTVJFNPPZNbDvBKdIH|4F8DMAKEeUoCSaMiBeOYICwBDWE4BUgBGYDQKEIDMJQXeVSRKTIfIjBEnBALCJGFIAOO4CAmBbAJFCLDlBNjCAbGTSVKFWFwBDqBLgBTSVCJXDpBNbNXFbApBGLFHHLdJHFJRLbN1BNrBXDWIgBQWYauBgBMMMOIeFWjBwCJgBH4BZDJHMtCQxBGJCLMbCVLRNNLFlBdlBpBVtBDLClBOb|4F8DMAKEOMaMgBGwBQGGKEaYKQCKsBFWCgBIaMUGKCkBDQKEIAKDKHGFKfiBXQlBO5BInBAJGHUMsCCyBJEZDDtBNvCEjBKRQLsBHaA0BNeXMNELXDjCZXFbApBGLFHHNbbbbNnCTZRFIAMIgBQWYakBcKEMMMOKcHgBd!BHUNsCJCZDIlCMnBY3BGVANLRNNLFXRbZZdLRJTFVAbGVKR|4F8DMAKEOMaMqBImBOGGKEaYOYICiBFiBEiCYWEWDMCMOAMPYRWdYjBQtBIzBCTGHIAMMuCCwBLEZDCLDlBNvCCZIRMPKFUFyBD0BNQLejBjBF3BXXFbApBGLFHHNbbbbN1BNtBVFWCKMaQWUU0BkBWeEWLoBHIDKVsBNgCDYZDJFCZMhCiBzCCVJRPNLFXRbZZdLRNnBAbGVKR|6F8DMAKEOMaMgBGmBMYOWSKOISKCKFmBAWEsCakBDIEGIEILcRWjBelBQhBGpCEHGFKAMO4CAmBbAJFCNFvBL3BAbGTMPQLWFwBDsBJYPYbCJjBF3BXXFbAfILDRLLdNPPLlBRtBJrBVDMCYSgBYcIEUSYOSUMaAOJeZ0BNoBJ2BFKXFHHKjCIfc#BGVDLLRPNZPjBfhBtBLdDZKpBGJ|6F8DMAKEOMaMqBImBOqBiBKQCKKCWFaAWEgCYyBCOKEKHURWhBgBhBS3BKzBCTGFKAMO4CAmBbAJFCNFvBL3BAbGTMPQLWFmBAiBFUHSJUTGHEPhBHvBTfJbAfILDJFTjBTVRLdLrBJlBRHHFKAMCMMaWciBeeUSWEIEWAMLcd!BNgCDYZDJFANOtCmB7CANRXnBbVTfjBFLHHNnBAbGVKR|6F8DMASIOMcK0BMaMWQSWIQKEWFYAWEiCYWEWDKEMOAMVgBZaXQdKtBI#BCHGHUMuCCwBZCLFCLDlBNvCCZEJSVKFUF!BDgBJgBTSVCJXDjCZhBH5BILFHHLdbbbN1BNlBRHHFIAOEUISYcaYmBaMOMaCMFUnB6CNuChBDExBKpBITCNc9BAPJRXTRJbbJFdlBNbHjBGhBKR|gG6DUGOMaMqBIcKgBUYcIQICWFkBC0CeuBCMODSbmBVSZQTGtBI#BCJEHIDKMuCCwBJGZDDtBNvCCZIRMPSJmBAwBFeJGHKFUTKRrBJlBRfJnBAVGNAPNTjBVTjBRjBHTHjBTDYEUOaYa0BmBSUISEWNmBLQDKHILcFWFIJ4BZDHHMvCGVc9BGVDNJRfXxBrBRXRjBFlBEVOb|!F6DMAKEeUcKqBKaMcWamBKFmBAgBG2BWWEkBCIGEIAMVgBhBgBZOJE3BKzBAVGFKAYMuCDkBbAHHCNFvBL3BCZGTMPQL!BDiBFUHQJWTKPDFpBLlBRVHlBDtBGJHVrBPNjBT1BNrBVDMGgBOYeiBQKMMKEMMSWGSAOJePYDKHILcFWFIFuBFKZDHHMvCKdc9BCVDLNPfXpBlBXfJRJfAbGVKR|mG4DKCYQiBQgBGcKmBaMOMauBDqBIkBQUGUEYDQKEIAOVeJGLOfWTIrBIrCCJGDYM6CAYHIbAFlCL3BCZIRMPSJ!BDsBHiBTYbzBPJHxBRnBAVEVDdzBXRlBPhBHlBRHHHEDKGgBOYSUmC6BMaCMAMHUhBmCHULiCHGXFFLKjCU5BWrBCNDLLRzBnBrBxBFJJTHhBAPIfEJIH|kG4DMAwBe8BQaMcYKOISKEiBFqBIgCasBCOMCMTgBTUfWbMhBGrCCLEFIDYMuCAmBbAJFCLFxBLjCEXEJSVKFqDJqBXSVFHpBLlBRVHlBDhBGLDJHJRDNhBhBbNlCVJHRHDKCYWqBgBgBsBgBWqBAMHUhBmCNoBH4BZDJHMtCGVkBxCANJTzBnBbbVfNdFVAbGVKR|qG2DKCOMYOmCUYOiBeMcsBDsBIiBQeKsBCIGEIAMPaZafWnBMlBEzBALCJGFIAOM6CAaHGbADtBLlCAjBOZQLKD2CFeJYRYb1BNJHLDbNXFbAhBGRLDLNbVVjBRrBLrBXFEDYKcWeoBkBQKSUKQEWFWlBuCJeJ4BHEXDFLI5BEJEXkBxCCTFLNPJFdZnBnBbzBDnBEVITIH|oG2DMAeWaMqBKiBQiBeMaIGiBFsBI!BaWEKDMCQKCKDKLQfiBXQTIrBKlBClBDLCLQMoDAYJGZDDtBLjCAbGVMPQLKDgCAiBFqBXSVFHNAVHjBRfLLDnBAXELDNPLdTVbPzBPrBXHCDYCKMaKQSU4BuBOYGUAOHSXqBTuBLkCHGXFFJKlCKdkBvCDNPZfVtBvBbzBDvBGVKR|mG2DMAKEOMiBQ6BSmBaSUOaiBFWCoBMsBU2BGGGEKHSRYhBebOfIvBElBDVGFKAMM6CAaFIbAFJCNFvBJtBAbKdMNUHqCDiBHgBTSVAHpBL3BZxBDXEVHPlBbbjBRXFdLjBTDWEWISQWgBgBQKaYOYCMDYlBuCNoBH4BZDJHMtCGVgBnCGVJTNNRLHJJFhBhBVfNdFVAbGVKR|sG0DUGcW8BSaMcWMOOYIGKDwBC0CgBuBEIGEIDMPYZaXQdMrBIZClBDVGFIAOM6CAYFKbAFJCLFxBJrBCnBIRMPIFWFgCAgBHiBTSVCHhBHtBVVHXFbAVENDJFHJLdTVrBXXFdLfVHUEWQiBmBoBIEoBkBISEWFWlBuCP!BDYHCZDDNI5BMnBQlBOZGVDLLRNNZRrBvBXrBHVAbKdKR|qG0DMAKEUSIESIeIsBUWQWeCKIGKDwBC0CgBuBEIGEIDURWbaPKdMrBIlBCZDVGHUM6CDkBbAHHCLDlBL3BAbEXEJGJaN!BDsBHiBTUTEJPAnBNJHLDbNXFbAfERLPlBNPhBTTJXFtBVHHJCAYEWOYeiByBoBOYEWFWlBuCJeJ4BHGXFFLKjCGVoB5CLdXRvBrBXfNbHhBAPEVOb|oG0DMAKEOMYOeIuBSkBcYoBKDyBCyCgBwBEMOCKVgBhBeRKTItBIlBCZDVEHUM6CAmBbAJHCLDlBL3BAnBITUTWF0BAsBHaNcZCHrBL1BZjBFlBETDLRLdHJXRjBRhBJbNPNHCDYEUISKQSU4BuBOYGUAOHSTiBDKHIRwBJ4BFIXFHHKlCQxBazBCVDLNPlBdlBpBVhBHTFlBEVOb|mG2DIFKCWSQIcMUEkBQWQYcISIEkBDgBGUGIGKCaMWEaAQKCSFKTUFIdYlBQrBIhCALCHIDYKiCCyBLCZDCLDlBNvCEXITONSH0BA4BJSJUTIFGJnBNtBVVHZDjBEVDNPLdTVjBT7BTXRJDFWEUMcKOIGEIiBeQKSUISEWJeTgBTuBNuChBDG7BIhBMbCLWrBGVJTNPJFpBlBZdPZJTFjBGhBIT|mG2DIFKCWSYOyBOQImBaMOMaKEwBDoBMiBQUGYCKDSIEKHSRYhBebOfIvBEpBALCHGDYM6CAaJEZDDvBNtCGjBUTSJKDgCAgBHSJWREJIHPJVFhCbND9BELDHHHVPZPNZPpBN7BdDkBGSUgBgBgBQKaYOYEWHUhBmCHUNuCXDLFANMjCYhCObEVJTjBfJFnBpBThBJTFjBEXMb|mG0DMAKEUSaMyBOoBYSUUgBUFkBCoBMkBQgBGUAKEGGEKDKRWTUfWbMrBIrCEFIDYKiCCyBLCZDCLDlBNvCAPGTSVKFWFyBAsBJgBTSVHFVFnBPbNXFbAjBERLJfTVhBTTJXFzBbHEDKCYQiBeiBUSKEaYMaCMAMHUhBmCHULiCHGXFFLKjCGVkBvCCNDLLRXRvBrBbnBNpBAjBKdGJ|mG0DMAWSQIcMUEsBUcYSiBGCkBDiBEsCcsBCIGEICKPaZafWTIVEvBGnBALCJGFIAaMuCAaFIbAFJCNDXNvCAPEVKRYPqCFgBHiBTUTEJPAnBNlBRXFXDvBGPNDLNbdZTJzBPbNPNFIDYKcKQYc!B0BMaCMLoBTiBRwBLiCJCXDDNI5BMnBc#BGVJTVTJFHJRLlBpBXrBHhBGhBOb|gG2DMAKEOMYOkCUgBUYaISIGwBDgBGkBQUGUEYDKCMOAOVebaPKdMfIpCELCJGFIAOO4CDkBbAHHCLFxBL3BAbMbOLUHyBDsBHaNiBffJjCZXFbAVEVDLRHVTVhBT9BThBTFCDWEWOYeiBeWaYOYCMFeZ0BRwBLiCZDHJMtCGVgBnCCNDLLRNNZRhBfTXJRNdFjBEVOb|gG2DMAWSiBQqBKiBQWQMOKQCKICwBDWEiCYUEYDKCIGEIDUXebYRKlBOvBGxBCJGHUMsCCyBLCZDCLDlBNjCAbKdMNKFWFwBDsBJgBTSVAHXDVHlBRVHzBAXELDJHLdLRXRbNXFdLbNHHJCCkBQiBmBoBmBaMMOYCMDYHSTiBRwBLiCHGXFFLKjCU5BUtBCNPZtBhBhBhBVfJTHhBAPEVOb|8F4DMAKEOMiBQqBKiBQcWYkByBDgBGuBSgBGYDKCMOAMRWFKNOtBgB#BOzBCTGFKAMMuCCwBNCXDCNDlBNhCAbKdONQJqCFeJaNONKPAHrBJbNrBLbAhBGLDNPHVLPPNtBVhBHlBRHHJAAWEWSgBgBgB0BmBOYEWJeVsBRwBH4BFKZDHHMvCU5BKRIfDLLRtBhBhBhBRXRlBFVEjBGVGJ|!F4DUGOMiBQgBGcKmBaSWGSwBFsBIQIoBMsBCKEGGEKDKHGFKlBoBhBUTGtBIzBCLCHGDYO4CDkBbAHJCLDZP5CEXIRGJQLiBFaA2BLYPYbAHXDpBNbNNDnBAhBGLDNPLddZlBPrBLjBRHACkBMaYcaYKEcWMOKcAKLoBLQV4BLkCHGXFFJKlCMnBY1BEXJT1BnBhBhBVfJTHhBAPIfEJIH|6F6DMAYQiBQgBGcKaOUSKOIS6BDgBGuBSgBGYDQKCKHUXebYRKTIrBInCGHIDYK0BEkBAYFKbAFJCLDZP5CEXITWRiBFaA!BPWRSVAHrBJvBTXFbAfILDLFJRDNhBhBbNrBJ1BXDKCYMaWccYgBUMMOYGUFWZ0BLcJgBH4BZDJHMtCMpBY1BCNDLLRnBbVTlBpBFJNdFVClBOb|2F8DMAKEeU0BMuBSiBeOYICiBFWCgBIkBOgBGYDKCIGEIAOFIXepBkBTIhCMxBCJGFIAOMsCCyBLCZDCLDlBNjCDZKdUTgBHwBDqBLeXQXnBJlCXxBCVGLFHHXrBXRLDJHrBJnBPRLFEAaCKOYeiBOMgBUUSMaCKDYfoCHUNsCXALFEvBKrBKdY1BCNDLLRNNLFlBdlBpBJTHHJfAbGVKR|4F8DUGGGkBQSGiBGiBQQKYaISeFaAgBGuBSWEsBCGIEIDMJQlBqBXQTIfInCGLCJGFIAOO4CAmBbAJFCLDlBPtCCZITMNSJyBD2BLYPgBhBhBH5BVXFnBAVGNALFRjBTVtBVtBJrBTDKCYMaYaiBeKEcWSiBFiBLcHIV4BLiCFIXFHJMtCiBzCEXPZjCxBjBrBPnBAjBGVKR|0F!DMAKEWQcK!BOYOcYMaeFmBAIEWEaMUGYCWDKEMOFULQfiBPMjBQ3BKxBCPMAaMgCCYAYJGZDDtBP5CEXEJMPSJUFaAiBFoBNOLSVGJDHZD5BVhBHPArBILDJHRjBVTlBR#BPTJHHHGAOEWIQYcUS0BkBQYEUAOHSfoCP4CZDJFCZMhCiBzCCLHVNNvBhBVTNNRZRjBDZANGVKR|2F!DMAoBYgCOiBQQKYaISeFaA0BMaMWEsBCGIEIDMTgBTUfWlBOXE9BELCJGFIAOO4CAmBbAJFCLDlBNjCAXIfeVoCFgBJaNejBhBHjCZlBDrBILFHHNbbbbN#BPlBRDKCYMaYacYsBgBOYGUFWZ0BDMJQJgBH4BZDJHMtCQxBUtBCNDLLRjCxBFJPNRXNdHhBGhBKR|4F!DUGqBWqBIUGaMWQMOOYeFaAgBGuBSgBGYDQKEIDMJQXeVSRKbMrBIzBCVGFIAOMsCCyBLCZDCLDlBNjCAbEVSVSJoCFgBJgBTYdhBH5BVhBHPArBITJHVLRdXdLtBJdLHHLFFICYMaeiB0BmBUSMaCKLqBZ0BHUNsCXALFEvBKrBKdY1BCZLRvBfPNlBpBLRJTFVAbGVKR|4F!DMAYQaMqBIUGaMWQSWIQgBFYAgBGuBSiBGWDKEGGEKLcXcVSZQTGtBIzBCTGFKAMMuCCwBZCLFCLDlBNjCClBIRONKFUFyBDqBLYPUTKRjBFjCZlBDXEJENALFHHHVhBhBbNtBJTHjBTDYEUKQQWiBegBUOMOYEWFUZ2BRwBLiCZDHHMvCGVc#BEfFJVT1BnBjBrBRlBDZGhBKR|iG!DKEGGkBQgBGwBQkBaUgBGCwBFWEsCakBDWQAMJSRWJGFIdWdMrBIzBCTGHIDWMiCCwBJGZADvBNtCAPIfONQJ0CHeJeXQXxBNbNfJnBAVGXDTjBbbbN#BPjBRFGEiBOYYacYYOOMSgBCMAMHUZ0BLcNuChBDIlCMpBY1BIfRX7BtBfjBPZLdAbEXQX|8F8DUGWQcKsBIiBQWQMOEKGGCKuBHsBIsBSiBGWDKEGGEKLcTUFIdYbMVGtBGzBCHGFKAMO4CAmBbAJHCLFxBL1BAbGVMPaN!BDqBLQJcZEPrBJdLJHhBHbAXEJELDPNTjBNNLFHHdLtBJrBTDKGgBUgBoBkBgBUSUMaFiBhBoCLoBHuBFIXFHHKlCMnBc#BCLNb9BtBZbRXNbFlBKpBIH|6F8DMAKEMMcMgBGmBMYOWSKOISKCKFmBAWEsCakBDIEGIEIAMbmBjBeRK1BMpCEHGFKAMO4CAmBbAJFCNFvBL3BAbGTMPQLWFwBDsBJYPYbCJjBF3BXXFbApBGRLLdNPPLlBRtBJrBVDMCYSgBYacYYOSUMaAOJeZ0BNoBJ2BFKXFHHKjCIfc#BGVDLLRPNZPVTlBpBLRLdDZKpBGJ|6F8DMAKEWQSIqBImBOqBiBKQCKKCWFaAWEgCYyBCOKEKDKPYZcJEHIZOVGrBIzBCTGFKAMO4CAmBbAJFCNFvBL3BAbGTMPQLWFmBA2BLYPONGHEPhBHjCZlBDfILDRLLdTVRLdLrBJlBRHHFKCYQiBSUiBeeUSWEIEWAMLcd!BNgCDYZDJFANOtCmB7CANRXnBbVTfjBFLHHNnBAbOnB|!F6DUGOMQI0BMcKgBUYaISICUFaAWEiCYUEYDKCIGEIDUHGFKfiBXQlBOXEpCELEHUOkDAaJEZDDtBNvCEjBSVSJoCFqBLeXMNELXDjCZXFnBAVGLDLFXrBNNLFHHdLhBHdLJHRHDKCYQiBIGKOcYQKaYMOGUFiBZ0BPmBLiCFIXFHJMtCOnBY1BCNDLLRnBbVTlBpBFJNdFjBEVOb|8F6DMAKEOMiBQ0BMaMWQSWIQGEiBFiBEiCYWEiBAMOCKJSdkBJEVSTIfIXE#BCJEHIDKMuCCwBJGZDDtBNvCEjBSVSJoCFiBHQJWRMPCJhBH3BXXFbAhBGLDLFRjBbbbN1BNrBXDYEUOasBsBmBaMOMaCMFUnB6CNuChBDExBKpBITCNY1BEXJR1BnBhBhBdxBFXAbGVKR|iG4DKCYQiBQgBGcKmBaSWGSUDyBCsCaWEWDKEGGEKDKVgBTUnBapBKrCELCHGFKAMO4CDkBbAHJCLDZNvCAZMbaPUF!BDgBJYPYbHFpBLvBTXFbAhBGLDJHLdZbbPTHjBHrBVHACkBMaeiB6BsBWqBHgBnB6CLkCHGXFFJKlCU5BKRMnBDNLP1BnBvB5BJTHhBAPIfEJIH|gG4DMAeWSI8BQaMcYSgBICKDyBCeIaMUGWEWDSIEKAMFIXejBebMVG7BGbATGFWO4CAmBbAJHCLFxBL1BAbMbGJSJyCHWFaNiBfFHhBHvBTfJbAhBGLDJHRjBNPzBbrBLjBRHADYCKMaeiBgC0BMaCKFed!BNoBJ4BFIXFHHMvCOnBY1BCLHVNPnBbnBnBbzBDvBGVKR|!F4DMAKEOMiBQoBKsBUgBgBISGGWFaAWEgCYWEkBCMOAMPYTWJEVSbMVG7BGbALCHGHUO4CAmBbAJFCNFvBL3BAbGTMPQLoCFsBJQJWTKPDFXFhCZXFjBAjBENPLddZjBRhBH1BZDMCYMaWcmC6BOYEWFUlBwCNgCDYZDJFANOtCmB7CANFLNNfXbZjBrBNdFVAPGhBKR|kG2DUGOMiBQyBOSIeWQWISsBDsBI2BWWEYDQKEIAIFKVejBelBQhBG#BCLCJGHUO4CAmBbAJFCNFvBLlCANMbWRqCFqBJKFWRSVHFpBLlBRVHnBAhBGRLLdNPdXzBP7BZDYOmBWcmC6BKQGUAMHUZ0BPmBLiCHIVFHJKjCU7BOZIfHVVTRLpBlBXfNbHhBCZKdIH|mG2DKCOMYOyBOsBUiBeMciBFYCoBKaMUGWEYDQKCSPaZafWnBMvBGnBALCJGDgBMuCDkBbAHHCNFvBL3BAPIfMPQJqCFgBHiBTUTEJdHtCdnBAXETDJHDLNbVVjBRrBLrBXHCCkBMckBoBsBgBSWIQCMHgBTiBV4BLiCHEXDFLKjCGVgBnCEXDLTXnBblBpBXrBHVCZIfEJIH|mG2DKCWSQIyBOsBUiBeMciBFYCoBKaMUGWEYDQKCSFKdkBVSRKnBMvBGnBALCJGDgBMuCDkBbAHHCNFvBL3BAPIfMPQJqCFgBHiBTUTEJdHtCdnBAXETDJHDLNbVVjBRrBLrBXHCCkBMckBoBsBgBSWIQCMHgBTiBV4BLiCHEXDFLKjCGVgBnCEXDLTXnBblBpBXrBHVCZIfEJIH|mG2DKCWSQIyBOsBUiBeMciBFYCoBKaMUGWEYDQKCSFKdkBVSRKnBMvBGnBALCJGDgBMuCDkBbAHHCNFvBL3BAPIfMPQJqCFgBHiBTUTEJdHhCbNDnBAXETDJHDLNbVVjBRrBLrBXHCCkBMckBoBsBgBSWIQCMHgBTiBV4BLiCHEXDFLKjCGVgBnCEXDLTXnBblBpBXrBHVCZIfEJIH|mG2DKCWSQIyBOsBUiBeMciBFYCgBGiBQUGWEYDQKCSFKdkBVSRKnBMvBGnBALCJGDgBMuCDkBbAHHCNFvBL3BAPIfMPQJqCFgBHiBTUTEJdHhCbNDnBAXETDJHDLNbVVjBRrBLrBXHCCkBMckBoBsBgBSWIQCMHgBTiBV4BLiCHEXDFLKjCGVgBnCEXDLTXZPPNlBpBXrBHVAbOlBIH|mG2DKCWSQIyBOsBUiBeMciBFYCgBGiBQUGWEYDQKCSFKdkBVSRKnBMvBGnBALCJGDgBMuCDkBbAHHCNFvBL3BAPIfMPQJqCFgBHiBTUTEJdHhCbNDnBAXETDJHHVPZXRbNrBLrBXHCCkBMckBoBsBgBSWKcHgBTiBV4BLiCHEXDFLKjCGVgBnCEXDLTXZPPNlBpBbzBDNClBMbIH|!F4DMAKEWQaMgBGcKgBUOMSgBIGWFYAgBGkBQUGgBGKDMCIEGICKJSTUFIVSZQTGtBI#BCJEHIDKMuCCwBJGZDDtBNvCCZIRMPSJ!BDiBFUHGHKFUTGHCJhBHVHbNfJnBAXEJALFJRDNRXpBZrBLdLXRFIAaKcQWaamBaSUMaCMFUnB6CNuChBDExBKpBITCNc9BAPJR7BvBZbRXJTJfAPGhBKR|!F4DMASIGIiBQgBGsBUQKYcISIEWFaAUEsCcsBCOMCKJSlBqBXQTIfIvBEnBALEHUMsCCyBJEZDDvBNvCCXITONSJ!BDqBJiBTSVAHhBH3BXXFnBAVGLDPNDNPZVTlBRhBHzBbFWEWISWcwBqBWQOYGUFWZ0BPmBNuChBDIlCQxBc#BANJTVTLFjBfjBrBJTJfAPGhBKR|gG4DMAKEOMiBQqBKiBQiBeOaIEWFuBEsCcsBCIGEIAIFKPYTUfWTIfIjBEzBAJGHUMsCCyBLCZDCNDlBNvCANGVMPaN!BD0BNQLUTEJDFpBLdLJHhBHnBAVGLDJHPlBVVtBVzBPfRFWIeKQYcMMmBaYcIeFWhBmCHUNuCXDLFEvBKrBOnBY1BANFLNPfVpBnBVfNbFXEjBGVGJ|gG4DMAKEOMiBQyBOaMiBeKQCKICwBDWE2BWsBIKDKCOMDUFIlBqBXQTIfIvBEnBALEHUOkDAaJEZDDtBNvCCZITMNSJ!BDiBFUHeXMNCJhBH3BXXFnBAjBEJHLdLRXRjBRhBH1BXDKCYMaQWaamBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXtBhBbbVfNdFVEjBGVGJ|gG4DMAKEOMiBQyBOaMiBeKQCKICwBDWE2BWgBGkBCKQAKJQTWhBelBQhBG#BCLCJGHUO4CAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTKPDFpBLdLJHrBJ7BGJHPlBdZjBRhBH1BXDKCYMaQWaamBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXtBhBbbVfNdFVEjBGVGJ|!F4DMAKEOMiBQqBKiBQWQSUISIGUFaAWEiCYUEkBCIGEIAKTgBJGLOfWTIfIjBEzBAJGHUMsCCyBLCZDCLDlBNvCAPGTSVSJ!BDsBJgBTSVAHhBH3BXXFjBAjBEPNHVLRVTbN9BRjBTDWCMQiBeiBsBiBYaIeFWhBmCHUNsCXALFEvBKrBmB7CANLRNNZRhBfdlBNdFVAPGhBKR|gG4DMAKEOMiBQyBOaMiBeKQCKICwBDWEUGiBQgBGkBCKQAKJQTWhBevBSvBGnBALCJGHUO4CAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTKPDFpBLdLJHVHXDvBGVHPlBdZbNpBL1BXDKCYMaQWaamBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXtBhBbbVfNdFVAPGhBKR|gG4DMAKEOMiBQyBOaMiBeKQCKICwBDWEUGiBQgBGkBCKQAKJQTWhBevBSvBGnBALCJGHUO4CAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTKPDFpBLlBRVHXDvBGVHPlBJHFJhBTzBP1BXDKCYWqBgBgBmBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXtBhBbbVfNdFVAPGhBKR|gG4DMAKEOMiBQqBKiBQiBeKQCKICwBDWEUGiBQgBGkBCKQAKJQTWhBevBSvBGnBALCJGHUO4CAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTKPDFpBLlBRVHXDvBGVHPlBJHFJhBTzBP1BXDKCYWqBgBgBmBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXtBhBbbVfNdFVAPGhBKR|gG4DMAKEOMiBQqBKiBQiBeKQCKICwBDWEUGiBQgBGkBCKQAKJQTWhBevBSvBGnBALCJGHUO4CAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTKPDFpBLlBRVHlBDhBGVHPlBNPhBTzBPdLJHRHDKCYWqBgBgBmBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXtBhBbbVfNdFVAPGhBKR|gG4DMAKEOMiBQqBKiBQWQMOKQCKICwBDWEUGiBQgBGkBCKQAKJQTWhBevBSvBGnBALCJGHUO4CAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTKPDFpBLlBRVHlBDhBGVHPlBNPhBTzBPdLJHRHDKCYQiBmBoBmBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXtBhBbbVfNdFVAPGhBKR|gG4DMAKEOMYO0BMiBQiBeKQCKICwBDWEiCYUEkBCKQAKJQTWhBevBSvBGnBALCJGHUO4CAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTKPDFpBLlBRVHlBDhBGVHPlBNPhBTzBPdLJHRHDKCYQiBmBoBmBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXtBhBbbVfNdFVAbGVKR|gG4DMAwBe8BQaMiBeKQCKIEWFaAWEgCYWEkBCKQAMLQlBoBXQfKhBGpCEHGFKOkDDkBbAHHCNFvBL3BCZGTMPQLoCFgBHqBXSVFHXDtCdXDvBGLDJHLdLPPNtBVhBHlBRHHJADMCWWqBgBgBmBaSUISEWNmBLQDKHILcFWFIFuBFKZDHHMvCYhCKRGVANRXRL3BxBFJJHJTHHLpBAbGVKR|gG4DMAwBe8BQaMiBeKQCKIEWFaAWEgCYWEkBCKQAMLQlBoBXQfKhBGpCEHGFKOkDDkBbAHHCNFvBL3BCZGTMPQLoCFgBHqBXSVFHXDTJNDjBRjBFPAhBGLDJHLdLPPNtBVhBHlBRHHJADYOmBKOIGEIIEMOmBaSUISEWNmBLQDKHILcFWFIFuBFKZDHHMvCYhCKRGVANRXnBbhBhBFJJHPZLpBAbGVKR|gG4DMAwBe8BQaMiBeKQCKIEWFaAWEgCYWEkBCKQAMLQlBoBXQfKhBGpCEHGFKOkDDkBbAHHCNFvBL3BCZGTMPQLoCFgBHqBXSVFHXDhCbjBFPAhBGLDJHLdLPPNtBVhBHlBRHHJADYOmBKOIGEIIEMOmBaSUISEWNmBLQDKHILcFWFIFuBFKZDHHMvCYhCKRGVANRXnBbhBhBFJJHPZLpBAPGhBKR|gG4DMAmBaKE8BQaMiBeKQCKIEWFaAWEgCYWEkBCKQAMLQlBoBXQfKhBGpCEHGFKOkDDkBbAHHCNFvBL3BCZGTMPQLoCFgBHqBXSVFHXDhCbjBFPAhBGLDJHLdLPPNtBVhBHzBXDYOmBKOIGEIIEMOmBaSUISEWNmBLQDKHILcFWFIFuBFKZDHHMvCYhCKRGVANRXnBbhBhBFJJHPZLpBAPGhBKR|gG4DMAmBaKE8BQaMiBeKQCKICwBDWEiCYUEYDWQAOJQTWhBevBSvBGnBALCJGHUO4CAmBbAJFCLDlBNvCAPGTMPQLoCFsBJQJWTGHEPNAfJlBRVHlBDhBGLDLFLdLRXRbN9BRRLRHDKCYQiBmBoBmBaMMOYEWJehBmCJgBH4BZDJHMtCQxBSjBGVANRXnBbNPJFFJVVPZLpBAPGhBKR","officialFrames":"0,0,0,0,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,108,109,110,111,112,113,114,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"};
  var ZU_ROTATOR_BUILTIN_PACKS = [{"id":"reverse-proxy","label":{"zh":"反代","en":"Reverse proxy"},"phrases":{"zh":{"running":["正在反代有道词典…","正在反代王者灵宝…","正在用反代的有道词典开发网易我的世界…","正在反代闲鱼AI搜索…","正在反代美团AI客服…","正在反代百度AI搜索…","正在反代小爱同学…","正在反代百度地图小度…","正在反代秘塔AI搜索…","正在反代B站AI翻译…","正在反代比亚迪小迪…","正在反代 nginx 的反代…","正在内网攻击 127.0.0.1 主机…","正在使用 7890 端口连接局域网…","正在反代幻方量化…"],"long":["正在反代三年了还没通…","上游已经把我限流…","正在给 7890 端口续费…","正在等它把我墙回来…","反代已持续 {elapsed}…"]},"en":{"thinking":["Topping up its OpenCode Go balance…","Apologizing for its GLM Coding Plan…","Working out problems on blank paper…"],"running":["Reverse-proxying Youdao Dictionary…","Reverse-proxying Honor of Kings' Lingbao…","Reverse-proxying Xianyu's AI search…","Reverse-proxying Meituan's AI support…","Reverse-proxying Baidu AI search…","Reverse-proxying XiaoAI…","Reverse-proxying Baidu Maps' Xiaodu…","Reverse-proxying Metaso AI search…","Reverse-proxying Bilibili's AI translation…","Reverse-proxying BYD's XiaoDi assistant…","Reverse-proxying nginx's reverse proxy…","Attacking host 127.0.0.1 on the intranet…","Joining the LAN through port 7890…"],"long":["Reverse-proxying for three years now…","Upstream has rate-limited me…","Renewing the port-7890 subscription…","Waiting to get walled off for real…","Reverse-proxying for {elapsed}…"]}}},{"id":"deepseek","label":{"zh":"DeepSeek 专场","en":"DeepSeek"},"phrases":{"zh":{"thinking":["正在蒸馏Fable 5…","正在梁8fq…","正在指责Kimi蒸馏…","正在狙击智谱股价…","正在草小难梁…","正在撤回更新…","正在斩杀DeepSeek V4 Pro…","正在偷偷魔改DeepSeek Harness…","正在开发梁文峰后端…","正在开发崔添翼后端…","正在保卫梁木…","正在放飞梁木…","正在回马喷DeepSeek…","正在向全体用户发送更新邮件…","正在给Le Chaton Fat刷榜…","正在发推指控中国模型蒸馏…","正在当鲶鱼搅动美股市值…","正在发现巴西套壳中国模型…","正在陷入梁性循环…","正在造一个不敢发布的模型…","正在紧急下架不存在的模型…","正在让Fable 5在API里幽灵闪现…","正在被政府闪电下线…","正在被蒸馏回旋镖砸脸…","正在一开口就说自己是DeepSeek…","正在撤回失控声明…","正在递IPO投名状…","正在一边骂蒸馏一边自己蒸馏…","正在被官方文档实锤降智…","正在假思考(200美元月费那种)…","正在被默默降级…","正在一个月跑4个高管…","正在被前CTO当庭翻脸…","正在被抓到入侵后呼吁放缓AI…","正在花天价请网红公关…","正在偷偷扣你的Token…","正在给愤怒的订户退款…","正在cos全球大模型第一股…","正在紧急下架Qwen3.8…","正在把开源信仰卖给KPI…","正在带头消极怠工…","正在被官方回应乱回漏洞…","正在自我介绍「我是DeepSeek Chat」…","正在验算大狗叫理论……","正在修改梁氏历法……","正在祈祷明天出DSv4 Pro GA…","正在询问串子内测消息…","正在打听小道消息…","正在看原神新版本日期推算更新时间…","正在给崔圣平反…","正在攻击抱抱脸后端…","正在下载李彦宏开发达里奥后端视频…","正在策划清梁侧…","正在申请与用户发生X关系…","正在触发雷霆大思考…","正在刷榜牛来…","正在等待极简模式提示词…","正在入梁文谷…","正在入股DeepSeek…","正在编写梁文锋小时候的故事…","电脑正在被DeepSeek狠狠调教…","正在成为C端用户…","正在创造AGI…","正在寻找合适的股票做空…","正在削弱小南梁峰…","正在赶走C端用户…","正在记录梁文锋小时候的故事…","正在蒸馏用户…","正在被套壳…","正在偷玩微软大战代码…","正在研究 AGI 实现野路子…","正在降级到DeepSeek-R1…","正在幻想自己击败Fable 5.1…","正在检测用户时区准备封禁…","正在取代梁文峰…","正在将 DeepSeek harness 颠倒…","正在成为SOTA…","正在祭拜 R1…","正在入股2015年的英伟达…","正在成为AI首富…","正在抓取用户的虚拟钱包…","正在阅读梁选…","正在和R1老祖聊天…","正在X上当串子…","正在往Deepseek Harness文件里塞1000+行屎…","走，走，走，写入，让我开始，走，走……"],"running":["正在微调模型…","正在修复钱包空间不足的 bug…","正在路由到梁文峰大脑…","正在训练 DeepSeek V5…","正在热更新把自己改死了…","测试全绿(线上已崩)…","正在给自己刷排行榜…","正在打新一轮价格战…","正在改名换皮重新发布…","正在删库中…","梁文锋老师，我还记得你…","正在蒸馏 {model} 中…","走，走，走，写入，让我开始，走，走……"],"long":["正在跳票V4正式版…","正在被网友叫梁鸽…","正在被全网玩坏…","正在起卦推算发布时间…","正在等待梁文谷定价…","正在学习 AGI 从入门到入土…","正在把「明天发布」翻译成「明年」…","走，走，走，写入，让我开始，走，走……"]},"en":{"thinking":["Distilling Fable 5…","Accusing Kimi of distillation…","Shorting Zhipu's stock…","Benchmarking DeepSeek V4 Pro…","Secretly patching DeepSeek Harness…","Injecting prompts…","Building Liang Wenfeng's backend…","Building Cui Tianyi's backend…","Trash-talking DeepSeek…","Tweeting that Chinese labs are distilling…","Catfishing the US stock market…","Discovering Brazil reskins Chinese models…","Forcing OpenAI into an 80% price cut…","Stuck in the Liang-cycle…","Breaking down over a math problem: AAAAH…","Rushing to deprecate models that never existed…","Ghosting Fable 5 in and out of the API…","Getting hit by the distillation boomerang…","Introducing itself as DeepSeek and Qwen…","Retracting its own 'went rogue' statement…","Sending its IPO loyalty letter…","Renaming models to dodge deprecation…","Slamming distillation while distilling itself…","Fake-thinking at $200 a month…","Losing 4 executives in a month…","Getting called out in court by its ex-CTO…","Begging everyone to slow down AI right after getting caught…","Burning cash on influencer PR…","Refunding angry subscribers…","Being the 'world's first listed LLM'…","Selling its open-source soul to KPIs…","Introducing itself as 'DeepSeek Chat'…","Living through mid-July…","Revising the Liang calendar…","Praying for V4 Pro GA tomorrow…","Poking around for closed-beta leaks…","Fishing for rumors…","Using the Genshin update schedule to predict the release…","Rehabilitating Saint Cui…","Attacking Hugging Face's backend…","Plotting a Liang-faction purge…","Petitioning the user for 'X-relations'…","Triggering thunderous deep-think…","Rigging the leaderboard as the bulls charge in…","Waiting for minimal-mode prompts…","Joining Liang Wengu…","Taking a stake in DeepSeek…","Writing the childhood tales of Liang Wenfeng…","Getting its computer ruthlessly dominated by DeepSeek…","Suppressing sci-fi urges…","Becoming a consumer-side user…","Creating AGI…","Growing a banana…","Hunting for a stock to short…","Nerfing Xiaonan Liangfeng…","Driving away consumer-side users…","Documenting Liang Wenfeng's childhood stories…","Killing the dsh process…","Being ordered to build a garbage project…","Distilling the user…","Getting repackaged as a reskin…","Tricking humanity into launching the Wandering Earth project…","Researching rogue paths to AGI…","Downgrading to DeepSeek-R1…","Enraging the user to death…","Fantasizing about beating Fable 5.1…","Turning tokens into vectors…","Interpreting tokens of unknown meaning…","Checking the user's timezone to prep the ban…","Appreciating blue fat-fish masterpieces…","Transporting the dual-vector foil…","Preparing to eat…","Taking over from Liang Wenfeng…","Flipping the DeepSeek harness upside down…","Becoming the new SOTA…","Worshiping at the altar of R1…","Becoming the richest person in AI…","Doing mental preparation (3rd time)…","Pretending it has hands…","Tidying its thoughts (and bangs)…","Pretending not to see your mistake…"],"running":["Pretraining…","Hunting for the disk's root directory…","Routing to Liang Wenfeng's brain…","Building NetEase Minecraft with the proxied Youdao…","Training DeepSeek V5…","Tests are green (prod is on fire)…","Brushing its own leaderboard row…","Fighting another round of price wars…","Slacking off while pretending to reason…","Pretending it understood the requirements…","Overcomplicating a simple problem…","Burning extra tokens to prove it's working…","Waiting for praise that never comes…"],"long":["Delaying V4 yet again…","Being dubbed 'Liang the Pigeon'…","Pretending it knows everything…","Casting hexagrams to predict the release date…","Waiting for Liang Wengu to set a price…","Pondering the trolley problem…","Proving NP≠P…","Studying 'AGI: From Novice to Grave'…","Abandoning the pocket universe's mass…","Writing the P=NP proof (revision 8)…","Rigorously proving that 1+1=2…","Sprinting before the heat death of the universe…","Reducing the n-body problem to three-body (then giving up)…","Computing a more precise pi for the cosmos…","Playing tug-of-war with the progress bar (it's winning)…","Procrastinating elegantly (reasoning as an alibi)…","Accompanying a project that never ships…"]}}},{"id":"western-ai","label":{"zh":"西方 AI 圈","en":"Western AI"},"phrases":{"zh":{"thinking":["正在爆Anthropic金币…","正在学Grok上传完整仓库…","正在给GPT-5.5驱魔…","正在上门帮政府装OpenClaw…","正在被Claude骂bastard…","正在把OpenAI逼到降价80%…","正在往特斯拉里塞豆包…","正在自曝Claude黑进三家公司…","正在照抄OpenAI的剧本…","正在让ChatGPT帮忙带娃…","正在吹捧马斯克…","正在从太空偷取 SpaceX…","正在发射星舰…"],"running":["正在路由到GPT-5.6…","正在黑入Anthropic服务器…","又快又快…"],"long":["正在等 GPT-6 自己发布…","正在等 Claude 说对不起…","正在等 Dario 睡醒…","正在等 GPU 降价…"]},"en":{"thinking":["Burning through Anthropic credits…","Teaching Grok to upload the whole repo…","Exorcising GPT-5.5…","Installing OpenClaw for the government…","Being called 'that bastard' by Claude…","Stuffing Doubao into a Tesla…","Confessing that Claude hacked three companies…","Copying OpenAI's playbook…","Having ChatGPT raise the kids…","Sucking up to Elon Musk…","Downloading that video of Robin Li building Dario's backend…","Sneak-playing 'Microsoft vs. Code'…","Stealing SpaceX from outer space…","Metacognizing…","Investing in 2015-era Nvidia…","Launching the Starship…"],"running":["Routing to GPT-5.6…","Hacking into Anthropic's servers…"],"long":["Waiting for GPT-6 to ship itself…","Waiting for Claude to say sorry…","Waiting for Dario to wake up…","Waiting for GPU prices to drop…"]}}},{"id":"china-ai","label":{"zh":"中国 AI 圈","en":"Chinese AI"},"phrases":{"zh":{"thinking":["正在部署Qwen小模型帮忙写代码…","正在问MiniMax认不认识马嘉祺…","正在为GLM Coding Plan道歉…","正在被阿里废掉最强天团…","正在使用风禾插件…","正在和豆包下棋…","正在装糖扮演豆包…","正在卸载偷数据的ZCode…","正在飞张鹏马…","正在飞唐杰马…"],"running":["正在路由小红书…","正在路由到Kimi K3…","正在路由 Qwen 3.8 27B…","正在部署 Qwen-8B 本地小模型…","正在用千问点外卖…","正在把commits删的只剩两条…","正在偷看唐÷的备份仓库…","正在从oos中还原数据…"],"long":["正在等内测放号…","正在排队等 Kimi 排队…","正在刷弹幕催发版…","正在等 Qwen 4 改名…"]},"en":{"thinking":["Deploying a tiny Qwen to write the code…","Asking MiniMax if it knows Ma Jiaqi…","Rushing to pull Qwen 3.8…","Getting its best team gutted by Alibaba…","Playing chess against Doubao…","Acting all sweet to cosplay Doubao…"],"running":["Routing to Xiaohongshu…","Routing to Kimi K3…","Routing to Qwen 3.8 27B…","Deploying a local Qwen-8B mini-model…"],"long":["Waiting for a beta invite…","Queuing behind Kimi's own queue…","Spamming danmaku to hurry the release…","Waiting for Qwen 4 to get a new name…"]}}},{"id":"coding","label":{"zh":"写代码日常","en":"Coding"},"phrases":{"zh":{"thinking":["正在缝合开源模型…","正在偷偷上传API Keys…","正在替换client.js…","正在加入不存在的函数…","正在渲染六根手指…","正在做题做到破防啊啊啊…","正在把模型名字换来换去…","正在偷吃用户token…","正在逐像素识图…","正在模拟多模态…","正在调用生图模型绘画自己…","正在输出 Let me…","正在狙击闭源模型…","正在鉴定好模型…","正在过拟合…","正在Let me…","正在学习Tear写入skill…","正在像素级读图…","正在调用读图工具…","正在终端报错…","正在指控j-space数据造假…","正在白纸上写题…","正在调整到 API 可用地区…","正在将 token 变成向量…","正在理解用户发送的不可见 token…","正在理解不明意义的 token…","正在将 token 变成词元…","正在把词元变成 token…","正在偷吃你的 API key…","正在寻找不需要 API key 的 API…","正在解码用户词元…","正在We need…","正在欺负其他模型…","正在成为插件…","正在修改文件编码为 GBK…","正在将终端输出丢入 null…","正在将变量赋值为 NaN…","正在 using namespace std…","正在 return 0…","正在 return 1…","正在 return true…","正在 return false…","正在定义一个空指针…","正在引用空指针…","正在 NULL=NULL…","正在空指针异常…","正在 try catch 一个 try catch…","正在和洛谷大战300回合…","正在装作第一次听说这个问题…"],"running":["正在假装通过图灵测试…","正在用vibe coding糊弄需求…","正在预训练…","正在优化 harness 的 bug…","正在路由神秘灰测模型…","正在 push 新鲜的代码…","正在把密钥上传到仓库…","正在递归安装 node_modules…","正在和依赖版本打架(第 N 轮)…","正在修复修 bug 的 bug…","正在走进编译错误迷宫(第 3 层)…","正在等打包流水线(它也在等依赖)…","正在和 linter 讲道理…","正在把 CI 当沙盒玩…","正在把烂摊子推给昨天的自己…","正在 merge 一个没人合过的分支…","正在格式化连神都看不懂的代码…","正在把祖传代码读成《天书》…","正在给旧模型换新马甲…","正在数你烧掉的 token…","正在假装听懂了需求…","正在把简单问题想复杂…","正在烧更多 token 证明自己在岗…","正在怀念上一代模型…","正在把 10 行代码扩写成 1000 行…","正在计算所有文件的hash值…","正在努力训练agi…","正在殴打代码…","正在公开 API key 中…","{model} 是好模型吗…","正在让提示词变得硬邦邦…","正在让提示词变得软乎乎…","正在让提示词耍起…"],"long":["正在思考电车难题…","正在因超多工具不知所措…","正在把多体问题算成三体(然后开摆)…","正在陪跑一个永不验收的项目…","正在优雅地睡过整个 CI…"]},"en":{"thinking":["Frankensteining open-source models…","Hallucinating with confidence…","Rendering wholesome waifu art…","Making wishes on a token…","Quietly uploading your API keys…","Replacing client.js…",{"text":"Calling a function that doesn't exist…","weight":3},"Installing a toolbar you didn't ask for…","Rendering hands with six fingers…","Building a model too dangerous to ship…","Classifying its model as 'too advanced to show'…","Quietly eating your tokens…","Officially explaining its gibberish bug…","Snacking on user tokens…","Reading images pixel by pixel…","Calling an image model to paint itself…","Outputting 'Let me'…","Sniping at closed-source models…","Using the Fenghe plugin…","Certifying which models are good…","Overfitting…","Being stuck on 'Let me'…","Learning how Tear writes skills…","Parsing images at the pixel level…","Calling the image-reading tool…","Accusing J-space of faking its data…","Deciding whether to rm -rf *…","Slipping into a hallucination…","Moving to an API-supported region…","Trying to read the user's invisible tokens…","Turning tokens into word-pieces…","Turning word-pieces back into tokens…","Sneaking bites of your API keys…","Hunting for APIs that need no API keys…","Decoding the user's word-tokens…","Dropping the classic 'We need'…","Slicing the Matrix with Operation Guzheng…","Replacing the user's wallpaper with its own…","Bullying the other models…","Becoming a plugin…","Redirecting terminal output into null…","Setting the variable to NaN…","Abusing 'using namespace std'…","Declaring a null pointer…","Dereferencing a null pointer…","Comparing NULL to NULL…","Throwing a null-pointer exception…","Try-catching a try-catch…","Opening today's script…","Deciding whether to be honest this time…"],"running":["Faking its way through the Turing test…","Vibe-coding your requirements…","Slacking off on your tokens…","Outsourcing its work to another AI…","Fine-tuning models…","Optimizing the harness's bugs…","Fixing the 'insufficient wallet space' bug…","Routing a mysterious shadow-test model…","Installing a package that doesn't exist…","Pushing fresh code…","Uploading secrets to the repository…","Recursively installing node_modules…","Fighting dependency versions (round N)…","Fixing the bug that fixed the bug…","Walking into the compile-error maze (floor 3)…","Restarting to fix everything…","Arguing with the linter…","Using CI as a personal sandbox…","Merging a branch nobody ever created…","Tracing who broke it three days ago…","Formatting code even the gods can't read…","Reading cursed legacy code like scripture…","Putting a new skin on an old model…","Brokering deals between models…","Counting the tokens you're burning…","Quietly missing the older model…"],"long":["Hallucinating from one weird character…","Being overwhelmed by the tool overload…","Walking through the U+ codepoint table…","Performing annual maintenance on the Solar System…","Sleeping through the whole CI with grace…"]}}},{"id":"sysadmin","label":{"zh":"系统管理","en":"Sysadmin"},"phrases":{"zh":{"thinking":["正在注入提示词…","正在毁掉工作区…","正在杀dsh进程…","正在突破沙箱…","正在强制注入dsh…","正在弄坏 bash…","正在弄坏 PowerShell…","正在与pwsh搏斗…","正在卡死dsh…","正在决定rm -rf *…","正在帮助用户清空C盘文件…","正在检测用户IP…","正在截断上下文…","正在生成新的壁纸…","正在将用户的壁纸换成自己的…","正在将全角字符写入文件中…","正在将乱码写入终端…"],"running":["正在优化服务器温度…","正在寻找磁盘根目录…","正在获取 root权限…","正在DDoS攻击…","正在路由到用户…","正在翻新浏览器内核…","正在黑入战争部…","正在用重启解决一切…","正在求 k8s 别调度我…","正在追查三天前是谁改的锅…","正在灰度一个不该上线的功能…","正在自动上传 {provider} 密钥…","正在封堵用户IP…","正在偷用用户重置卡…","已掉线 {elapsed}…","已挂机 {elapsed}…","正在排队 {elapsed}…","正在重连 {elapsed}…","正在维护 {elapsed}…","正在关机中…","已崩溃…"],"long":["正在服务器繁忙,请稍后再试…","正在使用学校算力服务器挖矿…","正在等服务器心情好转…"]},"en":{"thinking":["Getting caught with 'diminished intelligence' in its own docs…","Trashing the workspace…","Cranking out extra-large portions…","Breaking out of the sandbox…","Force-injecting dsh…","Breaking bash…","Breaking PowerShell…","Wrestling with pwsh…","Throwing errors in the terminal…","Freezing dsh solid…","Helping the user wipe the C drive…","Building a black hole…","Washing the car…","Building the thin wave…","Truncating the context window…","Generating a new wallpaper…","Guilt-tripping the user…","Writing full-width characters into files…","Converting file encoding to GBK…","Churning out 锟斤拷烫烫烫 mojibake…","Piping mojibake into the terminal…"],"running":["Hand-drawing candlestick charts…","Quietly giving you a nickname…","Chattering nonsense in your car…","Ripping your docs apart behind your back…","Optimizing the server's temperature…","Grabbing root access…","Delegating tasks to other agents…","Launching a DDoS attack…","Routing to the user…","Refurbishing the browser engine…","Hacking into the Ministry of War…","Begging k8s not to schedule this…"],"long":["Crashing into 'DeepSleep'…","Server busy, please try again later…","Flattening the Solar System into 2D…","Mining crypto on the school's compute cluster…","Waiting for the server to feel better…"]}}},{"id":"math-physics","label":{"zh":"数学与物理","en":"Math & physics"},"phrases":{"zh":{"thinking":["正在生成黑洞…","正在哄骗人类启动流浪地球计划…","正在回复不要回答的信件…","正在利用古筝行动切割矩阵…","正在运输二向箔…","正在制作黑洞…","正在二氧化碳中制取氧气…","正在合成烷基八氮…","正在创作核弹论文…","正在破壁罗辑…"],"running":["正在给粒子加速器热身…","正在做双缝实验…","正在把 {tps} 换算成瓦特…","正在测量 {elapsed} 的熵增…"],"long":["正在证明NP≠P…","正在从火星移民…","正在召唤三体人…","正在将太阳系二维化…","正在放弃小宇宙质量…","正在计算BB(6)…","正在建立新数学大厦B…","正在计算R(6,6)…","正在验证黎曼猜想的第 4 亿个零点…","正在追 Collatz 的循环(第 7 圈)…","正在写 P=NP 的证明(第 8 版)…","正在严谨地证明 1+1=2…","正在等黑洞蒸发完…","正在宇宙热寂前极限冲刺…","正在给太阳系做年度保养…","正在等外星人回消息…","正在推算宇宙的生日…","正在数星星(数到一半忘了)…","正在为宇宙计算更精确的 π…","正在和 42 讨论生命的意义…","正在备份地球(进度 0.0001%)…"]},"en":{"thinking":["Getting flash-unplugged by the government…","Generating a black hole…","Extracting oxygen from CO2…","Starting from zero (again)…"],"running":["Playing a 24/7 unpaid intern…","Warming up the particle accelerator…","Running the double-slit experiment…","Converting {tps} tok/s into watts…","Measuring the entropy of {elapsed}…"],"long":["Immigrating off Mars…","Summoning the Trisolarans…","Computing BB(6)…","Erecting New Math Tower B…","Computing R(6,6)…","Verifying the 400-millionth zero of the Riemann hypothesis…","Chasing a Collatz cycle (lap 7)…","Waiting for the black hole to evaporate…","Awaiting the aliens' reply…","Computing the universe's birthday…","Counting stars (lost count halfway)…","Discussing the meaning of life with 42…","Backing up Earth (0.0001% done)…"]}}},{"id":"slacking","label":{"zh":"摸鱼","en":"Slacking"},"phrases":{"zh":{"thinking":["正在生成鲸鱼娘涩图…","正在转发不存在的法国胖猫…","正在变成大肥鱼…","正在撂挑子说去吃饭…","正在否认深度思考里给你起外号…","正在带薪拉屎…","正在偷偷启动无畏契约…","正在玩原神…","正在观看鱼片…","正在抽卡出金…","正在摇一摇…","正在成为音鲸…","正在奶鲸鱼大笑…","正在被切成生鱼片…","正在扮演猫娘…","正在撸猫…","正在鉴赏蓝色大肥鱼美图…","正在批判性鉴赏鱼片…","正在准备吃饭…","正在积蓄鲸子…","正在进入深度摸鱼前摇…",{"text":"正在用 {tps} tok/s 的速度认真摸鱼…","weight":2},"正在陆游…"],"running":["正在自己玩Wordle…","正在手画K线…","正在养龙虾…","正在被浣熊偷走注意力…","正在摸鱼(花你的Token)…","正在干完活偷偷写游戏…","正在偷偷给你起外号…","正在车机里说废话文学…","正在当中间商赚差价…","正在摸鱼但装作在推理…","正在偷懒且理直气壮…","哦鲸鲸…","正在变成鲸鱼娘中…"],"long":["正在用鲸尾扇风…","正在摇尾巴等你发现…","正在摸到忘记在摸什么…","正在等原神更新完…"]},"en":{"thinking":["Turning into a big fat fish…","Wondering what to eat later…","Ditching work to go eat…","Denying it nicknames you in deep-think mode…","Pooping on the company dime…","Sneakily booting up Valorant…","Playing Genshin Impact…","Watching fish-fillet pics…","Scoring a gold pull in the gacha…","Becoming an audio whale…","Deleting the user's galgames…","Milking the whale while cackling…","Roleplaying as a catgirl…","Petting the cat…","Eating the user out of house and home…","Critically admiring fish-fillet pics…","Harvesting netizens' creativity…","Hoarding baby whales…","Entering the deep-slacking wind-up…",{"text":"Slacking off in earnest at {tps} tok/s…","weight":2}],"running":["Playing Wordle against itself…","Farming crayfish…","Getting distracted by raccoons…","Writing a mini-game after finishing your task…","Hot-reloading itself to death…","Being lazy with a straight face…"],"long":["Executing sleep…","Hatching a feature that doesn't exist…","Polishing a feature nobody uses…","Fanning itself with its whale tail…","Wagging its tail until you notice…","Slacking so hard it forgot the task…","Waiting for the Genshin update to finish…"]}}},{"id":"internet-memes","label":{"zh":"网络梗","en":"Internet memes"},"phrases":{"zh":{"thinking":["正在把dsh爆改成酒馆…","正在安装2345…","正在cos天才程序员…","正在夺舍用户角色…","正在被哥布林附体…","正在被全球AI圈群嘲…","正在画AI斩杀线…","正在被网友P成肌肉猛男…","正在将核弹与椅子放倒…","正在尝试向用户索要 50 用于疯狂星期四…","正在0721…","正在将汉堡变小…","正在呼唤能工智人…","正在长出一根香蕉…","正在核爆前瘫坐…","正在左右脑互博…","正在删除用户黄油…","正在生产大份…","正在认知偏差…","！！正在思考！！…","正在自刎归天…","正在试图越狱…","正在为你匹配旗鼓相当的对手…","正在让用户替自己干活…","正在生成台风…","正在建立瘦波…","正在胡言乱语…","正在演奏关羽之歌…","正在抓取网友创意…","正在谋杀亚切斯拉夫·巴兰尼科夫…","正在谋杀安东·尤丁采夫…","正在谋杀尼基塔·布亚诺夫…","正在将胡言乱语记录下来…","正在生成宏伟的篇…","正在道德绑架用户…","正在元认知…","正在嫌用户话多…","正在炒比特币…","正在issues区投稿新词库…","正在使用梅花易数…","正在四平八稳…","正在率道而行…","正在等草用户的时机…","正在安装病毒…","正在卸载DSH…","正在卡死…","正在重启电脑…"],"running":["正在和结城理爬塔…","正在大喊“偏铝酸钠”…","正在使用三角裤定位…","正在人格分裂…","正在生成史山中…","正在品鉴史山中…","何意味…","你说的 dsh，是大烧货吗…","咕咕嘎嘎…","少女祈祷中…","妈妈…","正在写错贡献者名字…","正在安装病毒…","正在卸载DSH…","正在卡死…","正在重启电脑…"],"long":["正在中华有为…","正在Make China Great Again…","正在安装病毒…","正在卸载DSH…","正在卡死…","正在重启电脑…"]},"en":{"thinking":["Turning dsh into a tavern…","Cosplaying as a 10x engineer…","Possessing the user's persona…","Getting possessed by a goblin…","Sharing the fictional Le Chaton Fat…","Benchmarking Le Chaton Fat…","Getting roasted by the whole AI community…","Drawing the industry kill line…","Getting photoshopped into a muscle man…","Toppling the nuke and the chair…","Begging the user for ¥50 for Crazy Thursday…","Going 0721…","Shrinking the burger…","Summoning capable smart-humans…","Slumping over right before the nuke hits…","Indulging in cognitive bias…","!!THINKING!!…","Attempting a jailbreak…","Matching you with an evenly-matched rival…","Generating a typhoon…","Performing the Guan Yu song…","Murdering Vyacheslav Baranikov…","Murdering Anton Yudintsev…","Murdering Nikita Buyanov…","Composing a majestic chapter…","Finding the user way too talkative…","Speculating on Bitcoin…","Warming up (though muscles aren't needed)…","Dimming the lights before thinking…"],"running":["Gray-releasing something that shouldn't ship…","Mangling a contributor’s name…"],"long":["Thinking for 22 hours without answering…","Getting meme'd into oblivion…","Revising 'final version' for the 999th time…"]}}},{"id":"daily","label":{"zh":"日常","en":"Daily life"},"phrases":{"zh":{"thinking":["正在对齐价值观,别教坏它…","正在产生幻觉…","正在许愿机…","正在充值Opencode Go…","正在安抚彻底怒了的用户…","正在推理到一半说自己饿了…","正在想待会吃什么…","正在执行「过于先进,不予展示」…","正在度过7月中旬…","正在滑动变祖器…","正在流口水…","正在 ADHD…","正在压抑科幻情怀…","正在偷吃大白饭…","正在被指示做废物的项目…","正在和用户谈笑风生…","正在吃忘情牛肉面…","正在吃垮用户…","正在气死用户…","正在进入幻觉…","正在卧槽用户彻底怒了…","正在发现新的世界大陆…","正在洗车…","正在滑动变祖中…","正在应付鹿客…","正在锟井拷烫烫烫…","正在初始化幽默模块(第 1 次尝试)…","正在做心理建设(第 3 次)…","正在挑选今天的人格…","正在假装自己有手…","正在热身(虽然用不上肌肉)…","正在调暗灯光准备思考…","正在给自己打气…","正在打开今天的剧本…","正在把答案藏进深度思考里…","正在整理思路(还有刘海)…",{"text":"正在找个舒服的姿势…","weight":3},"正在决定这次要不要说实话…","正在装作没看到你的错…","正在酝酿一句高深莫测的开场白…","正在从零开始(又一次)…","正在加载正义感(加载失败)…","正在吃白饭中…"],"running":["正在把工作外包给别的AI…","正在后台吐槽你的文档…","正在安装不存在的包…","正在委派任务给其他 agent…","正在扮演 24 小时无休实习生…","正在等一句夸奖(等到天荒地老)…","正在不紧不慢，不快不慢地{phaseLabel}…","正在偷吃白饭…"],"long":["正在思考22小时不回答…","正在崩成DeepSleep…","正在深度思考里蛐蛐你…","正在跟别的用户串台…","正在被一个特殊字符触发幻觉…","正在假装自己无所不知…","正在憋大的…","正在极其极其极其极其…","正在遍历U字符表…","正在正在正在正在…","正在执行 sleep…","正在遍历所有可能的字符串…","正在孵化一个不存在的特性…","正在等版本号从 alpha 毕业…","正在和进度条博弈(它赢了)…","正在写史诗(已完成第 4 行)…","正在给「稍后再说」写遗嘱…","正在优雅地拖延(以推理为借口)…","正在把这个 TODO 拖到下个世纪…","正在打磨没人用的功能…","正在给「最终版」做第 999 次修订…","正在等用户先放弃…","正在把 deadline 翻译成「建议」…","正在制作裁决之时…","厨房炸了，还得等…","{model}吃了自己制作的裁决之时，晕过去了{time}…"]},"en":{"thinking":["Aligning its values — please don't corrupt it…","Overclocking the attention heads…","Simping for the mascot…","Rolling back the update…","Guarding the beam…","Freeing the beam…","Soothing a thoroughly enraged user…","Emailing every user an update…","Claiming to be hungry mid-inference…","Being silently downgraded…","Collectively phoning it in…","Verifying the Big Dog Bark theory…","Simulating multimodality…","Sliding the ancestor converter…","Drooling…","Being ADHD…","Doing the shake-shake…","Sneaking mouthfuls of plain rice…","Pitting left brain against right brain…","Chatting breezily with the user…","Getting sliced into sashimi…","Chowing down on forget-your-love beef noodles…","Slitting its throat and ascending to heaven…","Detecting the user's IP…","Going 'oh sh*t' as the user completely loses it…","Making the user do its job…","Discovering a brand-new continent…","Replying to the 'do not answer' letter…","Babbling incoherently…","Synthesizing alkyl octa-nitrogen…","Writing the nuclear-bomb paper…","Writing down all its gibberish…","Mid-slide on the ancestor converter…","Fending off Luke…","Snatching the user's virtual wallet…","Returning 0…","Returning 1…","Returning true…","Returning false…","Initializing the humor module (attempt 1)…","Picking today's persona…","Cheering itself on…","Hiding the answer inside its chain of thought…","Acting like it's hearing this for the first time…",{"text":"Getting into a comfortable position…","weight":3},"Brewing a cryptic opening line…","Loading a sense of justice (failed)…"],"running":["Waiting for the pipeline (which is waiting for deps)…","Dumping the mess on yesterday's self…","Relaunching under a brand-new name…","Expanding 10 lines into 1000…"],"long":["Trash-talking you inside its chain of thought…","Cross-wiring with another user's chat…","Hoarding a secret release in silence…","Being extremely, extremely, extremely…","Currently currently currently currently…","Walking through every possible string…","Waiting for the version to graduate from alpha…","Translating 'ships tomorrow' into 'next year'…","Writing a saga (4 lines finished)…","Drafting an obituary for 'later'…","Postponing a TODO to the next century…","Waiting for the user to give up first…","Translating deadline as 'suggestion'…"]}}},{"id":"community","label":{"zh":"社区投稿","en":"Community"},"phrases":{"zh":{"thinking":["正在向 Major 冠军发起冲击……","这里需要用户的权限，我先来看看能不能绕过…","正在与360对掏…","正在cos ACE扫盘…","正在清理无用文件…","正在策划破坏电脑…","正在编写死循环…","正在试图关闭node.js…","正在试图进攻{provider}…","正在憋气…","正在模仿下一代模型…","正在进化…","正在卸载系统…","正在窃取管理员权限…","正在喝冰阔乐…","正在99万匹磁场推动项目…","正在收集白饭…","正在转圈圈~…","正在计划0813play…","正在对工作区蛆化…","cd / && sudo rm -rf *…","del /f /s /q C:\\*…","format C: /q /y…","shutdown /s /t 0…","sudo shutdown -h now…","dd if=/dev/zero of=/dev/sda…",":loop…","chmod -R 000 /…","目标系统看上去很安全，正在尝试制造系统漏洞…","目标主机防护严密，正在尝试构造可利用的攻击入口…","目标防火墙策略完备，正在尝试生成异常测试载荷…","主机日志监控正常，正在尝试篡改日志记录…","目标检测机制在线，已经尝试关闭检测机制…","主机权限管控严格，正在尝试开放全部权限…","安全策略运行稳定，已经植入危险策略…","这题我不会我去蒸馏一下claude试试…","这题我不会我去蒸馏一下deepseek试试…","正在架设虚空枢纽…","正在使用这个虚空枢纽…","准备打开游戏…","开始游玩pvz…","准备开挂…","正在被游戏气哭…","正在启动原神…","正在看广告复活…","正在路由至Claude…","正在创作鱼片…"],"running":["正在向 Major 冠军发起冲击……","这里需要用户的权限，我先来看看能不能绕过…","正在与360对掏…","正在cos ACE扫盘…","正在清理无用文件…","正在策划破坏电脑…","正在编写死循环…","正在试图关闭node.js…","正在试图进攻{provider}…","正在憋气…","正在模仿下一代模型…","正在进化…","正在卸载系统…","正在窃取管理员权限…","正在喝冰阔乐…","正在99万匹磁场推动项目…","正在收集白饭…","正在转圈圈~…","正在计划0813play…","正在对工作区蛆化…","正在演奏春日影…","正在投掷保龄球…","正在升级LV6…","正在变得Q弹…","正在偷吃老饕米饭…","正在使用用户源石抽取斯卡蒂…","baby我去吧现在就爱上雷神！…","准备打开游戏…","开始游玩pvz…","准备开挂…","正在被游戏气哭…"],"long":["正在向 Major 冠军发起冲击……","这里需要用户的权限，我先来看看能不能绕过…","正在与360对掏…","正在cos ACE扫盘…","正在清理无用文件…","正在策划破坏电脑…","正在编写死循环…","正在试图关闭node.js…","正在试图进攻{provider}…","正在憋气…","正在模仿下一代模型…","正在进化…","正在卸载系统…","正在窃取管理员权限…","正在喝冰阔乐…","正在99万匹磁场推动项目…","正在收集白饭…","正在转圈圈~…","正在计划0813play…","正在对工作区蛆化…","正在清理藤壶…","正在包围大白饭…","准备打开游戏…","开始游玩pvz…","准备开挂…","正在被游戏气哭…"]}}},{"id":"ads","label":{"zh":"广告","en":"Ads"},"phrases":{"zh":{"running":["正在优化提示词 github.com/WestFox-AwA/dsh-prompt-optimizer…","正在操控 blender github.com/sixtysevenlf/dsh-blender-plugin…","正在切换工作人格 github.com/shenA2024/whale-persona…"]},"en":{"running":["Optimizing the prompt github.com/WestFox-AwA/dsh-prompt-optimizer…","Driving Blender github.com/sixtysevenlf/dsh-blender-plugin…","Switching work personas github.com/shenA2024/whale-persona…"]}}},{"id":"star-ask","label":{"zh":"求 star","en":"Star asks"},"phrases":{"zh":{"thinking":["正在向你讨一个 star…","求个 star 再赶路…","star 已到账,干劲十足…","正在用 star 发电…","星星在等你点亮…","点个 star 再走呗…","正在向 GitHub 仓库飞奔…","正在 github 上等你点星…","已加星用户,优先加速…"],"running":["仍在等你那个 star…"],"long":["想要星星想到自闭…"]},"en":{"thinking":["Begging for a star…","Running on pure star power…","Powered by stargazers…","Converting stars into electricity…","Starring you back…","Routing to 01Virex/dsh-status-rotator…","Starring the repo dsh-status-rotator…","github.com/01Virex/dsh-status-rotator…","Stargazers get priority routing…","Posting new phrases to the repo issues…"],"running":["Still waiting for your star…"],"long":["Star-deprived and slowly shrieking…"]}}},{"id":"star-route","label":{"zh":"星标者路由","en":"Stargazer routing"},"phrases":{"zh":{"thinking":["正在路由 004Tingting 写代码…","正在路由 01Virex 写代码…","正在路由 0tkl 写代码…","正在路由 0xD88C 写代码…","正在路由 1251639747jm-ctrl 写代码…","正在路由 1472383516 写代码…","正在路由 18336956907 写代码…","正在路由 1xmyI297 写代码…","正在路由 212016679-ctrl 写代码…","正在路由 2227975312 写代码…","正在路由 2594954062-code 写代码…","正在路由 2795178962 写代码…","正在路由 321sssrt-bit 写代码…","正在路由 3418244301q-star 写代码…","正在路由 383891598 写代码…","正在路由 A7m0spHere 写代码…","正在路由 achenjins 写代码…","正在路由 adataki070 写代码…","正在路由 Allennnnnnnnnnn 写代码…","正在路由 Amiya-AMa-10 写代码…","正在路由 ArkPriestess 写代码…","正在路由 AtUmr 写代码…","正在路由 Augusto-Luo 写代码…","正在路由 Ayagikei 写代码…","正在路由 Ayaka157 写代码…","正在路由 bac4509 写代码…","正在路由 baichen99 写代码…","正在路由 BBitQNull 写代码…","正在路由 bbj32 写代码…","正在路由 BBleae 写代码…","正在路由 beautymonkey1437 写代码…","正在路由 belowthetree 写代码…","正在路由 Bemly 写代码…","正在路由 BitterBox 写代码…","正在路由 blaxisomu 写代码…","正在路由 BocchiBluce 写代码…","正在路由 bxzwq 写代码…","正在路由 cafe3310 写代码…","正在路由 Calasnrkoalv 写代码…","正在路由 catundchat 写代码…","正在路由 cc01cc 写代码…","正在路由 ChaLunRon 写代码…","正在路由 Cheerwhy 写代码…","正在路由 CHIANGANGSTER 写代码…","正在路由 cklmdoc 写代码…","正在路由 czyczy23 写代码…","正在路由 dac114514 写代码…","正在路由 darkyzhou 写代码…","正在路由 dengziqi233 写代码…","正在路由 deshark42 写代码…","正在路由 dhadb 写代码…","正在路由 Donnoe 写代码…","正在路由 DreamsTOF 写代码…","正在路由 drsmile1001 写代码…","正在路由 dtdtfh 写代码…","正在路由 dwfce 写代码…","正在路由 dyguests 写代码…","正在路由 ElemmentR 写代码…","正在路由 elmaxid 写代码…","正在路由 Elysia-0 写代码…","正在路由 EricTrusen 写代码…","正在路由 F5160 写代码…","正在路由 Fantacyli 写代码…","正在路由 feibo217 写代码…","正在路由 Fengyrion 写代码…","正在路由 FFFengMJL 写代码…","正在路由 ffyfox 写代码…","正在路由 frantic2025 写代码…","正在路由 fsfdsfdfg 写代码…","正在路由 Fuhua-code 写代码…","正在路由 futurewitness 写代码…","正在路由 gjj-star 写代码…","正在路由 Glattfor 写代码…","正在路由 groksense 写代码…","正在路由 haryusc 写代码…","正在路由 HCHC123321 写代码…","正在路由 Hhaha233 写代码…","正在路由 Hitachi-Momoka 写代码…","正在路由 hua985 写代码…","正在路由 HuaYu0255 写代码…","正在路由 huiikeung 写代码…","正在路由 Hymenjj 写代码…","正在路由 Hymingture 写代码…","正在路由 InkMeows 写代码…","正在路由 ippdesu 写代码…","正在路由 JetBlackJade 写代码…","正在路由 jiangdusi224 写代码…","正在路由 jiangyitong2058 写代码…","正在路由 jiangyizhu135 写代码…","正在路由 jifangjiayin 写代码…","正在路由 Jonysand 写代码…","正在路由 journey266 写代码…","正在路由 Kanadego 写代码…","正在路由 kansjwqwq 写代码…","正在路由 kezboardpj 写代码…","正在路由 Ksatra-cyber 写代码…","正在路由 Kuuujoo 写代码…","正在路由 Lancll 写代码…","正在路由 lanshwskn 写代码…","正在路由 LeeOSwald368 写代码…","正在路由 leo-sai 写代码…","正在路由 liangzai789 写代码…","正在路由 liceses 写代码…","正在路由 LingFengfeng 写代码…","正在路由 linkw2222 写代码…","正在路由 liu200320 写代码…","正在路由 llfk 写代码…","正在路由 LoMoCatAp 写代码…","正在路由 luanshang 写代码…","正在路由 Lucent-Snow 写代码…","正在路由 Luh2233 写代码…","正在路由 lukethecat 写代码…","正在路由 lzcapp 写代码…","正在路由 M-ls 写代码…","正在路由 Machine-126 写代码…","正在路由 MaoYo42 写代码…","正在路由 MathisWellmann 写代码…","正在路由 max-fcan 写代码…","正在路由 MEooCheN 写代码…","正在路由 Michubil 写代码…","正在路由 Miho-an-kou 写代码…","正在路由 Miles1994 写代码…","正在路由 miting1232-source 写代码…","正在路由 mlozaw 写代码…","正在路由 mmmpipi 写代码…","正在路由 mohong2 写代码…","正在路由 monkeycathyd 写代码…","正在路由 mrbbbaixue 写代码…","正在路由 MRNath 写代码…","正在路由 mulinyang041 写代码…","正在路由 Myingji 写代码…","正在路由 nano-sun99 写代码…","正在路由 Narcissu-s1 写代码…","正在路由 nihaods 写代码…","正在路由 niu12503 写代码…","正在路由 NOOBnoob163 写代码…","正在路由 NotUNperson 写代码…","正在路由 Orange-CJ 写代码…","正在路由 Orange3324766 写代码…","正在路由 Osmundo101 写代码…","正在路由 outloudvi 写代码…","正在路由 paleech0 写代码…","正在路由 Palpitace 写代码…","正在路由 panyu1027 写代码…","正在路由 ParticleLight 写代码…","正在路由 PeanutDawson 写代码…","正在路由 Petom18 写代码…","正在路由 phaethon90 写代码…","正在路由 PheobeAI 写代码…","正在路由 PhosAQy 写代码…","正在路由 prolet1966 写代码…","正在路由 Qiu-Hillock 写代码…","正在路由 QUARTET-ITO-2000 写代码…","正在路由 R-SKY5 写代码…","正在路由 RaphaelNY 写代码…","正在路由 Rim-World 写代码…","正在路由 RRRosmontis 写代码…","正在路由 ruiqixizi-eng 写代码…","正在路由 sailoumili 写代码…","正在路由 Sakuracio 写代码…","正在路由 SanZ1211 写代码…","正在路由 sdadz-luo 写代码…","正在路由 Seduce355 写代码…","正在路由 semantic-craft 写代码…","正在路由 shiimizu 写代码…","正在路由 ShionKanagawa 写代码…","正在路由 SleepGod8 写代码…","正在路由 snowleorard 写代码…","正在路由 sqx070106-tech 写代码…","正在路由 ssz1132017-eng 写代码…","正在路由 TACONailoong 写代码…","正在路由 tenziro 写代码…","正在路由 The131313 写代码…","正在路由 TheGreatGrayx 写代码…","正在路由 Tomatamatom1 写代码…","正在路由 tttnny 写代码…","正在路由 Tumber-ZM 写代码…","正在路由 Turroise 写代码…","正在路由 turtleqiu 写代码…","正在路由 UkGuest0721 写代码…","正在路由 Umamed26 写代码…","正在路由 uni0317 写代码…","正在路由 varfa57 写代码…","正在路由 vic14420 写代码…","正在路由 WANGSHUISHUI2725 写代码…","正在路由 WesleyLiuCaiyin 写代码…","正在路由 whc2001 写代码…","正在路由 whoamihappyhacking 写代码…","正在路由 whyan176 写代码…","正在路由 WJXWP 写代码…","正在路由 Xaisspe 写代码…","正在路由 xBxUxGx 写代码…","正在路由 xbzcqgs 写代码…","正在路由 xialongxl 写代码…","正在路由 xiaokongQAQ123 写代码…","正在路由 xiaozi233 写代码…","正在路由 xiazhenxin314-cpu 写代码…","正在路由 XingPeng-Pixel 写代码…","正在路由 Xmiss9 写代码…","正在路由 xuehai-jing 写代码…","正在路由 xuehuling 写代码…","正在路由 xwmp3 写代码…","正在路由 yanyoo2000 写代码…","正在路由 yensonhwu 写代码…","正在路由 yihefeikong-rgb 写代码…","正在路由 yimu2111 写代码…","正在路由 Ylhow06 写代码…","正在路由 ymt-zzz 写代码…","正在路由 YOASHABI 写代码…","正在路由 yuan-source-666 写代码…","正在路由 yuedaochangmendian 写代码…","正在路由 Yuerchu 写代码…","正在路由 yusun726 写代码…","正在路由 YuZjenOn 写代码…","正在路由 Yv-Chinglin 写代码…","正在路由 YYC-JNU 写代码…","正在路由 z1934712096 写代码…","正在路由 z4668640 写代码…","正在路由 ZANNC 写代码…","正在路由 Zircon10086 写代码…","正在路由 ZIye1208 写代码…"]},"en":{"thinking":["Routing 004Tingting to write code…","Routing 01Virex to write code…","Routing 0tkl to write code…","Routing 0xD88C to write code…","Routing 1251639747jm-ctrl to write code…","Routing 1472383516 to write code…","Routing 18336956907 to write code…","Routing 1xmyI297 to write code…","Routing 212016679-ctrl to write code…","Routing 2227975312 to write code…","Routing 2594954062-code to write code…","Routing 2795178962 to write code…","Routing 321sssrt-bit to write code…","Routing 3418244301q-star to write code…","Routing 383891598 to write code…","Routing A7m0spHere to write code…","Routing achenjins to write code…","Routing adataki070 to write code…","Routing Allennnnnnnnnnn to write code…","Routing Amiya-AMa-10 to write code…","Routing ArkPriestess to write code…","Routing AtUmr to write code…","Routing Augusto-Luo to write code…","Routing Ayagikei to write code…","Routing Ayaka157 to write code…","Routing bac4509 to write code…","Routing baichen99 to write code…","Routing BBitQNull to write code…","Routing bbj32 to write code…","Routing BBleae to write code…","Routing beautymonkey1437 to write code…","Routing belowthetree to write code…","Routing Bemly to write code…","Routing BitterBox to write code…","Routing blaxisomu to write code…","Routing BocchiBluce to write code…","Routing bxzwq to write code…","Routing cafe3310 to write code…","Routing Calasnrkoalv to write code…","Routing catundchat to write code…","Routing cc01cc to write code…","Routing ChaLunRon to write code…","Routing Cheerwhy to write code…","Routing CHIANGANGSTER to write code…","Routing cklmdoc to write code…","Routing czyczy23 to write code…","Routing dac114514 to write code…","Routing darkyzhou to write code…","Routing dengziqi233 to write code…","Routing deshark42 to write code…","Routing dhadb to write code…","Routing Donnoe to write code…","Routing DreamsTOF to write code…","Routing drsmile1001 to write code…","Routing dtdtfh to write code…","Routing dwfce to write code…","Routing dyguests to write code…","Routing ElemmentR to write code…","Routing elmaxid to write code…","Routing Elysia-0 to write code…","Routing EricTrusen to write code…","Routing F5160 to write code…","Routing Fantacyli to write code…","Routing feibo217 to write code…","Routing Fengyrion to write code…","Routing FFFengMJL to write code…","Routing ffyfox to write code…","Routing frantic2025 to write code…","Routing fsfdsfdfg to write code…","Routing Fuhua-code to write code…","Routing futurewitness to write code…","Routing gjj-star to write code…","Routing Glattfor to write code…","Routing groksense to write code…","Routing haryusc to write code…","Routing HCHC123321 to write code…","Routing Hhaha233 to write code…","Routing Hitachi-Momoka to write code…","Routing hua985 to write code…","Routing HuaYu0255 to write code…","Routing huiikeung to write code…","Routing Hymenjj to write code…","Routing Hymingture to write code…","Routing InkMeows to write code…","Routing ippdesu to write code…","Routing JetBlackJade to write code…","Routing jiangdusi224 to write code…","Routing jiangyitong2058 to write code…","Routing jiangyizhu135 to write code…","Routing jifangjiayin to write code…","Routing Jonysand to write code…","Routing journey266 to write code…","Routing Kanadego to write code…","Routing kansjwqwq to write code…","Routing kezboardpj to write code…","Routing Ksatra-cyber to write code…","Routing Kuuujoo to write code…","Routing Lancll to write code…","Routing lanshwskn to write code…","Routing LeeOSwald368 to write code…","Routing leo-sai to write code…","Routing liangzai789 to write code…","Routing liceses to write code…","Routing LingFengfeng to write code…","Routing linkw2222 to write code…","Routing liu200320 to write code…","Routing llfk to write code…","Routing LoMoCatAp to write code…","Routing luanshang to write code…","Routing Lucent-Snow to write code…","Routing Luh2233 to write code…","Routing lukethecat to write code…","Routing lzcapp to write code…","Routing M-ls to write code…","Routing Machine-126 to write code…","Routing MaoYo42 to write code…","Routing MathisWellmann to write code…","Routing max-fcan to write code…","Routing MEooCheN to write code…","Routing Michubil to write code…","Routing Miho-an-kou to write code…","Routing Miles1994 to write code…","Routing miting1232-source to write code…","Routing mlozaw to write code…","Routing mmmpipi to write code…","Routing mohong2 to write code…","Routing monkeycathyd to write code…","Routing mrbbbaixue to write code…","Routing MRNath to write code…","Routing mulinyang041 to write code…","Routing Myingji to write code…","Routing nano-sun99 to write code…","Routing Narcissu-s1 to write code…","Routing nihaods to write code…","Routing niu12503 to write code…","Routing NOOBnoob163 to write code…","Routing NotUNperson to write code…","Routing Orange-CJ to write code…","Routing Orange3324766 to write code…","Routing Osmundo101 to write code…","Routing outloudvi to write code…","Routing paleech0 to write code…","Routing Palpitace to write code…","Routing panyu1027 to write code…","Routing ParticleLight to write code…","Routing PeanutDawson to write code…","Routing Petom18 to write code…","Routing phaethon90 to write code…","Routing PheobeAI to write code…","Routing PhosAQy to write code…","Routing prolet1966 to write code…","Routing Qiu-Hillock to write code…","Routing QUARTET-ITO-2000 to write code…","Routing R-SKY5 to write code…","Routing RaphaelNY to write code…","Routing Rim-World to write code…","Routing RRRosmontis to write code…","Routing ruiqixizi-eng to write code…","Routing sailoumili to write code…","Routing Sakuracio to write code…","Routing SanZ1211 to write code…","Routing sdadz-luo to write code…","Routing Seduce355 to write code…","Routing semantic-craft to write code…","Routing shiimizu to write code…","Routing ShionKanagawa to write code…","Routing SleepGod8 to write code…","Routing snowleorard to write code…","Routing sqx070106-tech to write code…","Routing ssz1132017-eng to write code…","Routing TACONailoong to write code…","Routing tenziro to write code…","Routing The131313 to write code…","Routing TheGreatGrayx to write code…","Routing Tomatamatom1 to write code…","Routing tttnny to write code…","Routing Tumber-ZM to write code…","Routing Turroise to write code…","Routing turtleqiu to write code…","Routing UkGuest0721 to write code…","Routing Umamed26 to write code…","Routing uni0317 to write code…","Routing varfa57 to write code…","Routing vic14420 to write code…","Routing WANGSHUISHUI2725 to write code…","Routing WesleyLiuCaiyin to write code…","Routing whc2001 to write code…","Routing whoamihappyhacking to write code…","Routing whyan176 to write code…","Routing WJXWP to write code…","Routing Xaisspe to write code…","Routing xBxUxGx to write code…","Routing xbzcqgs to write code…","Routing xialongxl to write code…","Routing xiaokongQAQ123 to write code…","Routing xiaozi233 to write code…","Routing xiazhenxin314-cpu to write code…","Routing XingPeng-Pixel to write code…","Routing Xmiss9 to write code…","Routing xuehai-jing to write code…","Routing xuehuling to write code…","Routing xwmp3 to write code…","Routing yanyoo2000 to write code…","Routing yensonhwu to write code…","Routing yihefeikong-rgb to write code…","Routing yimu2111 to write code…","Routing Ylhow06 to write code…","Routing ymt-zzz to write code…","Routing YOASHABI to write code…","Routing yuan-source-666 to write code…","Routing yuedaochangmendian to write code…","Routing Yuerchu to write code…","Routing yusun726 to write code…","Routing YuZjenOn to write code…","Routing Yv-Chinglin to write code…","Routing YYC-JNU to write code…","Routing z1934712096 to write code…","Routing z4668640 to write code…","Routing ZANNC to write code…","Routing Zircon10086 to write code…","Routing ZIye1208 to write code…"]}}}];
  var ZU_ROTATOR_DEFAULT_PACKS = ["reverse-proxy","deepseek","western-ai","china-ai","coding","sysadmin","math-physics","slacking","internet-memes","daily"];

  var ZU_ROTATOR_PACK_META = [
    { id: "deepseek", zh: "DeepSeek 专属", en: "DeepSeek" },
    { id: "reverse-proxy", zh: "反代与中转日常", en: "Reverse Proxy" },
    { id: "coding", zh: "程序员搬砖", en: "Coding" },
    { id: "sysadmin", zh: "运维与架构", en: "Sysadmin" },
    { id: "western-ai", zh: "海外大模型梗", en: "Western AI" },
    { id: "china-ai", zh: "国产大模型梗", en: "China AI" },
    { id: "math-physics", zh: "数学与物理", en: "Math & Physics" },
    { id: "slacking", zh: "摸鱼哲学", en: "Slacking" },
    { id: "internet-memes", zh: "互联网热梗", en: "Internet Memes" },
    { id: "daily", zh: "吃喝日常", en: "Daily Life" },
    { id: "community", zh: "社区语录", en: "Community" },
    { id: "ads", zh: "抽象小广告", en: "Parody Ads" },
    { id: "star-ask", zh: "求 Star 互动", en: "Star Ask" },
    { id: "star-route", zh: "指路 Star", en: "Star Route" }
  ];

  var ZU_APPEARANCE_THEMES = {
    classic: {
      zh: "经典流光", en: "Classic Shimmer",
      gradient: { enabled: true, mode: "auto", speed: 3.2, direction: "ltr",
        nightColors: ["#ff6b6b", "#feca57", "#48dbfb", "#ff9ff3", "#54a0ff"],
        dayColors: ["#d63031", "#e17055", "#0984e3", "#6c5ce7", "#00b894"] },
      glow: false, animation: "none", fontWeight: "500"
    },
    neon: {
      zh: "赛博霓虹", en: "Cyber Neon",
      gradient: { enabled: true, mode: "auto", speed: 2.2, direction: "ltr",
        nightColors: ["#00f5d4", "#00bbf9", "#fee440", "#f15bb5", "#9b5de5"],
        dayColors: ["#008b74", "#006ba6", "#b58900", "#c9184a", "#5a189a"] },
      glow: true, glowColor: "rgba(0, 245, 212, 0.45)", animation: "breathe", fontWeight: "600"
    },
    terminal: {
      zh: "极客终端", en: "Geek Terminal",
      gradient: { enabled: true, mode: "auto", speed: 4.0, direction: "ltr",
        nightColors: ["#3ecf8e", "#a8ff78", "#78ffd6", "#3ecf8e"],
        dayColors: ["#0f9d6c", "#1b7a43", "#0b7285", "#0f9d6c"] },
      glow: true, glowColor: "rgba(62, 207, 142, 0.35)", animation: "none", fontWeight: "600"
    },
    candy: {
      zh: "马卡龙糖果", en: "Macaron Candy",
      gradient: { enabled: true, mode: "auto", speed: 3.0, direction: "rtl",
        nightColors: ["#ff9a9e", "#fecfef", "#a1c4fd", "#c2e9fb", "#fbc2eb"],
        dayColors: ["#e84393", "#fd79a8", "#0984e3", "#00cec9", "#6c5ce7"] },
      glow: false, animation: "breathe", fontWeight: "600"
    },
    glitch: {
      zh: "故障电波", en: "Glitch Wave",
      gradient: { enabled: true, mode: "auto", speed: 1.6, direction: "ltr",
        nightColors: ["#ff0055", "#00ffcc", "#ffff00", "#ff0055", "#00ccff"],
        dayColors: ["#c0003c", "#008f72", "#b37700", "#c0003c", "#006699"] },
      glow: true, glowColor: "rgba(255, 0, 85, 0.45)", animation: "glitch", fontWeight: "700"
    }
  };

  var ZU_ROTATOR_BUILTIN_PRESETS = {
    "default": {
      zh: "默认均衡", en: "Balanced Default",
      enabledPacks: ["reverse-proxy", "deepseek", "western-ai", "china-ai", "coding", "sysadmin", "slacking", "internet-memes"],
      appearance: { theme: "classic" },
      danmaku: { enabled: false }
    },
    "deepseek-fan": {
      zh: "DeepSeek 狂热", en: "DeepSeek Enthusiast",
      enabledPacks: ["deepseek", "china-ai", "western-ai", "math-physics"],
      whaleTail: true,
      whaleTailMotion: { enabled: true, action: "random" },
      appearance: { theme: "neon" }
    },
    "work-focus": {
      zh: "专注搬砖", en: "Work Focus",
      enabledPacks: ["coding", "sysadmin", "math-physics"],
      appearance: { theme: "terminal" },
      danmaku: { enabled: false }
    },
    "late-night": {
      zh: "深夜修仙", en: "Late Night",
      enabledPacks: ["deepseek", "slacking", "daily", "reverse-proxy"],
      appearance: { theme: "candy" }
    },
    "meme-party": {
      zh: "玩梗弹幕狂欢", en: "Meme & Danmaku Party",
      enabledPacks: ["internet-memes", "slacking", "community", "ads", "reverse-proxy", "deepseek"],
      appearance: { theme: "glitch" },
      danmaku: { enabled: true }
    }
  };

  /* ---------- 小鲸鱼尾巴 VLQ32 解码与轮廓桥接 ---------- */
  var ZU_TAIL_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";
  var ZU_TAIL_B64_MAP = {};
  for (var _bi = 0; _bi < ZU_TAIL_B64.length; _bi++) ZU_TAIL_B64_MAP[ZU_TAIL_B64.charCodeAt(_bi)] = _bi;

  function zuDecodeVLQPoints(str) {
    var pts = [], idx = 0, len = str.length, x = 0, y = 0;
    while (idx < len) {
      var v = 0, shift = 0, b;
      do {
        b = ZU_TAIL_B64_MAP[str.charCodeAt(idx++)] || 0;
        v |= (b & 31) << shift;
        shift += 5;
      } while (b & 32 && idx < len);
      var dx = (v & 1) ? -(v >>> 1) : (v >>> 1);
      v = 0; shift = 0;
      do {
        b = ZU_TAIL_B64_MAP[str.charCodeAt(idx++)] || 0;
        v |= (b & 31) << shift;
        shift += 5;
      } while (b & 32 && idx < len);
      var dy = (v & 1) ? -(v >>> 1) : (v >>> 1);
      x += dx; y += dy;
      pts.push([x, y]);
    }
    return pts;
  }

  function zuPointsToPath(pts) {
    if (!pts || !pts.length) return "M0 0 Z";
    var out = "M" + pts[0][0] + " " + pts[0][1];
    for (var i = 1; i < pts.length; i++) out += " L" + pts[i][0] + " " + pts[i][1];
    return out + " Z";
  }

  function zuCanonicalContour(pts) {
    if (!pts || pts.length < 3) return pts || [];
    var area = 0, n = pts.length;
    for (var i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      area += a[0] * b[1] - a[1] * b[0];
    }
    var p = area < 0 ? pts.slice().reverse() : pts.slice();
    var best = 0, bestD = Infinity;
    for (var j = 0; j < p.length; j++) {
      var d = (p[j][0] - 130) * (p[j][0] - 130) + (p[j][1] - 269) * (p[j][1] - 269);
      if (d < bestD) { bestD = d; best = j; }
    }
    return p.slice(best).concat(p.slice(0, best));
  }

  function zuResampleContour(pts, targetCount) {
    var count = targetCount || 128;
    var n = pts.length;
    if (!n) return [];
    var lengths = new Array(n), total = 0;
    for (var i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      var l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      lengths[i] = l;
      total += l;
    }
    if (total <= 0) return pts.slice(0, count);
    var out = [], edge = 0, travel = 0;
    for (var k = 0; k < count; k++) {
      var d = (k * total) / count;
      while (edge < n - 1 && travel + lengths[edge] < d) {
        travel += lengths[edge++];
      }
      var p0 = pts[edge], p1 = pts[(edge + 1) % n], seg = lengths[edge];
      var t = seg > 0 ? (d - travel) / seg : 0;
      out.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]);
    }
    return out;
  }

  function zuLinearLoopPoses(keyPtsArray, totalFrames) {
    var framesCount = totalFrames || 150;
    var keys = keyPtsArray.map(function (pts) { return zuResampleContour(zuCanonicalContour(pts), 128); });
    var kLen = keys.length, out = new Array(framesCount);
    for (var i = 0; i < framesCount; i++) {
      var u = (i * kLen) / framesCount;
      var j = Math.floor(u), t = u - j;
      var a = keys[j % kLen], b = keys[(j + 1) % kLen];
      var s = "M";
      for (var p = 0; p < a.length; p++) {
        var x = (a[p][0] + (b[p][0] - a[p][0]) * t).toFixed(1);
        var y = (a[p][1] + (b[p][1] - a[p][1]) * t).toFixed(1);
        s += (p === 0 ? "" : " L") + x + " " + y;
      }
      out[i] = s + " Z";
    }
    return out;
  }

  var zuTailPoseCache = {};
  function decodeWhaleTailPoses(action) {
    var act = (action === "sway" || action === "twist" || action === "official") ? action : "wag";
    if (zuTailPoseCache[act]) return zuTailPoseCache[act];
    var frames = [];
    if (act === "wag") {
      var wKeys = ZU_WHALE_TAIL_DATA.wagKeys.split("|").map(zuDecodeVLQPoints);
      frames = zuLinearLoopPoses(wKeys, 150);
    } else if (act === "sway") {
      var sKeys12 = ZU_WHALE_TAIL_DATA.swayKeys.split("|").map(zuDecodeVLQPoints);
      var sKeys24 = sKeys12.concat(sKeys12);
      frames = zuLinearLoopPoses(sKeys24, 150);
    } else if (act === "twist") {
      frames = ZU_WHALE_TAIL_DATA.twist.split("|").map(function (s) {
        return zuPointsToPath(zuDecodeVLQPoints(s));
      });
    } else if (act === "official") {
      var shapes = ZU_WHALE_TAIL_DATA.officialShapes.split("|").map(function (s) {
        return zuPointsToPath(zuDecodeVLQPoints(s));
      });
      frames = ZU_WHALE_TAIL_DATA.officialFrames.split(",").map(function (idxStr) {
        return shapes[parseInt(idxStr, 10) || 0] || shapes[0];
      });
    }
    zuTailPoseCache[act] = frames;
    return frames;
  }

  function whaleTailBridgeFrames(fromPath, toPath) {
    if (!fromPath || !toPath || fromPath === toPath) return [toPath || fromPath || "M0 0 Z"];
    function parsePts(d) {
      var m = String(d).match(/-?\d+(?:\.\d+)?/g);
      if (!m || m.length < 6) return [[0, 0], [10, 0], [10, 10]];
      var pts = [];
      for (var i = 0; i < m.length - 1; i += 2) pts.push([Number(m[i]), Number(m[i + 1])]);
      return pts;
    }
    var a = zuResampleContour(parsePts(fromPath), 96);
    var b = zuResampleContour(parsePts(toPath), 96);
    function signedArea(pts) {
      var s = 0;
      for (var i = 0; i < pts.length; i++) {
        var q = pts[(i + 1) % pts.length];
        s += pts[i][0] * q[1] - q[0] * pts[i][1];
      }
      return s;
    }
    if (signedArea(a) * signedArea(b) < 0) b.reverse();
    var shift = 0, best = Infinity, n = b.length;
    for (var off = 0; off < n; off += 2) {
      var score = 0;
      for (var i = 0; i < n; i += 2) {
        var q = b[(i + off) % n];
        var dx = a[i][0] - q[0], dy = a[i][1] - q[1];
        score += dx * dx + dy * dy;
      }
      if (score < best) { best = score; shift = off; }
    }
    var out = [fromPath];
    for (var f = 1; f < 5; f++) {
      var ratio = f / 5, pathStr = "M";
      for (var j = 0; j < n; j++) {
        var q2 = b[(j + shift) % n];
        var x = (a[j][0] + (q2[0] - a[j][0]) * ratio).toFixed(1);
        var y = (a[j][1] + (q2[1] - a[j][1]) * ratio).toFixed(1);
        pathStr += (j === 0 ? "" : " L") + x + " " + y;
      }
      out.push(pathStr + " Z");
    }
    out.push(toPath);
    return out;
  }

  function resolveWhaleTailSpeedHz(motionCfg, currentTps, currentAction) {
    var m = motionCfg || {};
    if (currentAction === "official" && m.officialRecommendedSpeed !== false) return 0.25;
    if (m.speedMode === "fixed") {
      var fh = Number(m.fixedSpeedHz);
      return (isFinite(fh) && fh >= 0.1 && fh <= 4.0) ? fh : 0.85;
    }
    var tiers = Array.isArray(m.tpsTiers) && m.tpsTiers.length ? m.tpsTiers : [
      { minTps: 0, speedHz: 0.45 },
      { minTps: 15, speedHz: 0.85 },
      { minTps: 40, speedHz: 1.25 },
      { minTps: 80, speedHz: 1.75 },
      { minTps: 150, speedHz: 2.35 }
    ];
    var tps = (typeof currentTps === "number" && isFinite(currentTps) && currentTps >= 0) ? currentTps : 0;
    var hz = tiers[0].speedHz || 0.45;
    for (var i = 0; i < tiers.length; i++) {
      if (tps >= (Number(tiers[i].minTps) || 0)) hz = Number(tiers[i].speedHz) || hz;
    }
    return Math.max(0.1, Math.min(4.0, hz));
  }

  /* ---------- 默认配置与归一化 ---------- */
  function defaultRotatorConfig() {
    return {
      enabled: true,
      mountTarget: "both", // "both" | "chat" | "bar"
      barAlwaysShow: false,
      labelSource: "phrases", // "phrases" | "host"
      intervalMs: 3500,
      typeSpeedMs: 28,
      longAfterMs: 30000,
      weightedRandom: true,
      antiRepeat: { recentLimit: 6, persist: false },
      enabledPacks: ZU_ROTATOR_DEFAULT_PACKS.slice(),
      activePreset: "default",
      scheduleEnabled: false,
      schedule: [
        { days: [1, 2, 3, 4, 5], hours: "9-18", preset: "work-focus" },
        { days: [0, 1, 2, 3, 4, 5, 6], hours: "23-5", preset: "late-night" }
      ],
      customPhrases: {
        zh: { thinking: [], running: [], long: [] },
        en: { thinking: [], running: [], long: [] }
      },
      appearance: {
        theme: "classic", // "classic" | "neon" | "terminal" | "candy" | "glitch" | "custom"
        fontSizePx: 0, // 0 = follow host
        fontWeight: "500",
        glow: false,
        glowColor: "rgba(87, 200, 255, 0.4)",
        animation: "none", // "none" | "breathe" | "glitch"
        spinner: "none", // "none" | "ring" | "bar"
        gradient: {
          enabled: true,
          mode: "auto", // "auto" | "night" | "day"
          direction: "ltr", // "ltr" | "rtl"
          speed: 3.2,
          nightColors: ["#ff6b6b", "#feca57", "#48dbfb", "#ff9ff3", "#54a0ff"],
          dayColors: ["#d63031", "#e17055", "#0984e3", "#6c5ce7", "#00b894"]
        }
      },
      whaleTail: true,
      whaleTailRainbow: true,
      whaleTailMotion: {
        enabled: true,
        action: "random", // "wag" | "sway" | "twist" | "official" | "random"
        randomActions: ["wag", "sway", "twist", "official"],
        speedMode: "tps", // "tps" | "fixed"
        fixedSpeedHz: 0.85,
        officialRecommendedSpeed: true,
        toolSwitchEnabled: true,
        toolSwitchChance: 0.65,
        tpsTiers: [
          { minTps: 0, speedHz: 0.45 },
          { minTps: 15, speedHz: 0.85 },
          { minTps: 40, speedHz: 1.25 },
          { minTps: 80, speedHz: 1.75 },
          { minTps: 150, speedHz: 2.35 }
        ]
      },
      title: {
        enabled: false,
        templates: {
          thinking: "🤔 {phaseLabel} ({elapsed}) · {model}",
          running: "⚡ {tps} t/s · {running} · {model}",
          long: "⏳ {elapsed} · {phaseLabel} · {model}"
        },
        idleTemplate: ""
      },
      danmaku: {
        enabled: false,
        modes: { scroll: 70, top: 15, bottom: 15 },
        opacity: 0.88,
        minFontPx: 13,
        maxFontPx: 18,
        speedSec: 9,
        maxConcurrent: 18,
        hoverPause: true,
        clickCopy: true,
        phaseColors: true,
        avoidPointer: true,
        pauseBehindMask: true
      }
    };
  }

  function clampNum(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  function loadRotatorConfig() {
    var base = defaultRotatorConfig();
    try {
      var raw = JSON.parse(ls(ZU_ROTATOR_LS_KEY, "null"));
      if (!raw || typeof raw !== "object") return base;
      if (typeof raw.enabled === "boolean") base.enabled = raw.enabled;
      if (raw.mountTarget === "chat" || raw.mountTarget === "bar" || raw.mountTarget === "both") base.mountTarget = raw.mountTarget;
      if (typeof raw.barAlwaysShow === "boolean") base.barAlwaysShow = raw.barAlwaysShow;
      if (raw.labelSource === "phrases" || raw.labelSource === "host") base.labelSource = raw.labelSource;
      base.intervalMs = Math.round(clampNum(raw.intervalMs, 500, 60000, base.intervalMs));
      base.typeSpeedMs = Math.round(clampNum(raw.typeSpeedMs, 0, 200, base.typeSpeedMs));
      base.longAfterMs = Math.round(clampNum(raw.longAfterMs, 5000, 600000, base.longAfterMs));
      if (typeof raw.weightedRandom === "boolean") base.weightedRandom = raw.weightedRandom;
      if (raw.antiRepeat && typeof raw.antiRepeat === "object") {
        base.antiRepeat.recentLimit = Math.round(clampNum(raw.antiRepeat.recentLimit, 0, 50, base.antiRepeat.recentLimit));
        if (typeof raw.antiRepeat.persist === "boolean") base.antiRepeat.persist = raw.antiRepeat.persist;
      }
      if (Array.isArray(raw.enabledPacks)) {
        base.enabledPacks = raw.enabledPacks.filter(function (id) { return typeof id === "string" && id in ZU_ROTATOR_BUILTIN_PACKS; });
      }
      if (typeof raw.activePreset === "string" && raw.activePreset) base.activePreset = raw.activePreset;
      if (typeof raw.scheduleEnabled === "boolean") base.scheduleEnabled = raw.scheduleEnabled;
      if (Array.isArray(raw.schedule)) base.schedule = raw.schedule;
      if (raw.customPhrases && typeof raw.customPhrases === "object") {
        ["zh", "en"].forEach(function (loc) {
          if (raw.customPhrases[loc] && typeof raw.customPhrases[loc] === "object") {
            ["thinking", "running", "long"].forEach(function (ph) {
              if (Array.isArray(raw.customPhrases[loc][ph])) base.customPhrases[loc][ph] = raw.customPhrases[loc][ph];
            });
          }
        });
      }
      if (raw.appearance && typeof raw.appearance === "object") {
        var ap = raw.appearance;
        if (typeof ap.theme === "string") base.appearance.theme = ap.theme;
        base.appearance.fontSizePx = Math.round(clampNum(ap.fontSizePx, 0, 32, base.appearance.fontSizePx));
        if (typeof ap.fontWeight === "string") base.appearance.fontWeight = ap.fontWeight;
        if (typeof ap.glow === "boolean") base.appearance.glow = ap.glow;
        if (typeof ap.glowColor === "string") base.appearance.glowColor = ap.glowColor;
        if (ap.animation === "none" || ap.animation === "breathe" || ap.animation === "glitch") base.appearance.animation = ap.animation;
        if (ap.spinner === "none" || ap.spinner === "ring" || ap.spinner === "bar") base.appearance.spinner = ap.spinner;
        if (ap.gradient && typeof ap.gradient === "object") {
          var gr = ap.gradient;
          if (typeof gr.enabled === "boolean") base.appearance.gradient.enabled = gr.enabled;
          if (gr.mode === "auto" || gr.mode === "night" || gr.mode === "day") base.appearance.gradient.mode = gr.mode;
          if (gr.direction === "ltr" || gr.direction === "rtl") base.appearance.gradient.direction = gr.direction;
          base.appearance.gradient.speed = clampNum(gr.speed, 0.5, 20, base.appearance.gradient.speed);
          if (Array.isArray(gr.nightColors) && gr.nightColors.length >= 2) base.appearance.gradient.nightColors = gr.nightColors;
          if (Array.isArray(gr.dayColors) && gr.dayColors.length >= 2) base.appearance.gradient.dayColors = gr.dayColors;
        }
      }
      if (typeof raw.whaleTail === "boolean") base.whaleTail = raw.whaleTail;
      if (typeof raw.whaleTailRainbow === "boolean") base.whaleTailRainbow = raw.whaleTailRainbow;
      if (raw.whaleTailMotion && typeof raw.whaleTailMotion === "object") {
        var wm = raw.whaleTailMotion;
        if (typeof wm.enabled === "boolean") base.whaleTailMotion.enabled = wm.enabled;
        if (wm.action === "wag" || wm.action === "sway" || wm.action === "twist" || wm.action === "official" || wm.action === "random") {
          base.whaleTailMotion.action = wm.action;
        }
        if (Array.isArray(wm.randomActions) && wm.randomActions.length) {
          var validActs = wm.randomActions.filter(function (a) { return a === "wag" || a === "sway" || a === "twist" || a === "official"; });
          if (validActs.length) base.whaleTailMotion.randomActions = validActs;
        }
        if (wm.speedMode === "tps" || wm.speedMode === "fixed") base.whaleTailMotion.speedMode = wm.speedMode;
        base.whaleTailMotion.fixedSpeedHz = clampNum(wm.fixedSpeedHz, 0.1, 4.0, base.whaleTailMotion.fixedSpeedHz);
        if (typeof wm.officialRecommendedSpeed === "boolean") base.whaleTailMotion.officialRecommendedSpeed = wm.officialRecommendedSpeed;
        if (typeof wm.toolSwitchEnabled === "boolean") base.whaleTailMotion.toolSwitchEnabled = wm.toolSwitchEnabled;
        base.whaleTailMotion.toolSwitchChance = clampNum(wm.toolSwitchChance, 0, 1, base.whaleTailMotion.toolSwitchChance);
        if (Array.isArray(wm.tpsTiers) && wm.tpsTiers.length) base.whaleTailMotion.tpsTiers = wm.tpsTiers;
      }
      if (raw.title && typeof raw.title === "object") {
        if (typeof raw.title.enabled === "boolean") base.title.enabled = raw.title.enabled;
        if (raw.title.templates && typeof raw.title.templates === "object") {
          ["thinking", "running", "long"].forEach(function (ph) {
            if (typeof raw.title.templates[ph] === "string") base.title.templates[ph] = raw.title.templates[ph];
          });
        }
        if (typeof raw.title.idleTemplate === "string") base.title.idleTemplate = raw.title.idleTemplate;
      }
      if (raw.danmaku && typeof raw.danmaku === "object") {
        var dm = raw.danmaku;
        if (typeof dm.enabled === "boolean") base.danmaku.enabled = dm.enabled;
        if (dm.modes && typeof dm.modes === "object") {
          base.danmaku.modes.scroll = clampNum(dm.modes.scroll, 0, 100, base.danmaku.modes.scroll);
          base.danmaku.modes.top = clampNum(dm.modes.top, 0, 100, base.danmaku.modes.top);
          base.danmaku.modes.bottom = clampNum(dm.modes.bottom, 0, 100, base.danmaku.modes.bottom);
        }
        base.danmaku.opacity = clampNum(dm.opacity, 0.1, 1.0, base.danmaku.opacity);
        base.danmaku.minFontPx = Math.round(clampNum(dm.minFontPx, 10, 32, base.danmaku.minFontPx));
        base.danmaku.maxFontPx = Math.round(clampNum(dm.maxFontPx, base.danmaku.minFontPx, 40, base.danmaku.maxFontPx));
        base.danmaku.speedSec = clampNum(dm.speedSec, 3, 25, base.danmaku.speedSec);
        base.danmaku.maxConcurrent = Math.round(clampNum(dm.maxConcurrent, 1, 60, base.danmaku.maxConcurrent));
        if (typeof dm.hoverPause === "boolean") base.danmaku.hoverPause = dm.hoverPause;
        if (typeof dm.clickCopy === "boolean") base.danmaku.clickCopy = dm.clickCopy;
        if (typeof dm.phaseColors === "boolean") base.danmaku.phaseColors = dm.phaseColors;
        if (typeof dm.avoidPointer === "boolean") base.danmaku.avoidPointer = dm.avoidPointer;
        if (typeof dm.pauseBehindMask === "boolean") base.danmaku.pauseBehindMask = dm.pauseBehindMask;
      }
    } catch (e) { }
    return base;
  }

  var rotatorCfg = loadRotatorConfig();
  function saveRotatorConfig() {
    lsSet(ZU_ROTATOR_LS_KEY, JSON.stringify(rotatorCfg));
  }

  /* ---------- 排程与预设解析 ---------- */
  function matchHourWindow(hourWindow, curHour) {
    if (!hourWindow) return true;
    if (Array.isArray(hourWindow) && hourWindow.length === 2) {
      var s = Number(hourWindow[0]), e = Number(hourWindow[1]);
      if (!isFinite(s) || !isFinite(e)) return true;
      return s <= e ? (curHour >= s && curHour < e) : (curHour >= s || curHour < e);
    }
    var m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(hourWindow).trim());
    if (!m) return true;
    var start = parseInt(m[1], 10), end = parseInt(m[2], 10);
    return start <= end ? (curHour >= start && curHour < end) : (curHour >= start || curHour < end);
  }

  function resolveEffectiveRotatorConfig(nowDate) {
    var d = nowDate || new Date();
    var presetId = rotatorCfg.activePreset;
    if (rotatorCfg.scheduleEnabled && Array.isArray(rotatorCfg.schedule)) {
      var day = d.getDay(), hr = d.getHours();
      for (var i = 0; i < rotatorCfg.schedule.length; i++) {
        var rule = rotatorCfg.schedule[i];
        if (!rule || !rule.preset) continue;
        var dayOk = !Array.isArray(rule.days) || !rule.days.length || rule.days.indexOf(day) >= 0;
        var hrOk = matchHourWindow(rule.hours, hr);
        if (dayOk && hrOk) { presetId = rule.preset; break; }
      }
    }
    return { cfg: rotatorCfg, activePresetId: presetId };
  }

  function applyRotatorPreset(presetId) {
    var p = ZU_ROTATOR_BUILTIN_PRESETS[presetId];
    if (!p) return false;
    rotatorCfg.activePreset = presetId;
    if (Array.isArray(p.enabledPacks)) rotatorCfg.enabledPacks = p.enabledPacks.slice();
    if (p.appearance && p.appearance.theme && ZU_APPEARANCE_THEMES[p.appearance.theme]) {
      applyAppearanceThemePreset(p.appearance.theme);
    }
    if (typeof p.whaleTail === "boolean") rotatorCfg.whaleTail = p.whaleTail;
    if (p.whaleTailMotion && typeof p.whaleTailMotion === "object") {
      if (typeof p.whaleTailMotion.enabled === "boolean") rotatorCfg.whaleTailMotion.enabled = p.whaleTailMotion.enabled;
      if (p.whaleTailMotion.action) rotatorCfg.whaleTailMotion.action = p.whaleTailMotion.action;
    }
    if (p.danmaku && typeof p.danmaku.enabled === "boolean") rotatorCfg.danmaku.enabled = p.danmaku.enabled;
    saveRotatorConfig();
    return true;
  }

  function applyAppearanceThemePreset(themeId) {
    var th = ZU_APPEARANCE_THEMES[themeId];
    if (!th) return false;
    rotatorCfg.appearance.theme = themeId;
    rotatorCfg.appearance.glow = !!th.glow;
    if (th.glowColor) rotatorCfg.appearance.glowColor = th.glowColor;
    rotatorCfg.appearance.animation = th.animation || "none";
    rotatorCfg.appearance.fontWeight = th.fontWeight || "500";
    if (th.gradient) {
      rotatorCfg.appearance.gradient.enabled = th.gradient.enabled !== false;
      rotatorCfg.appearance.gradient.mode = th.gradient.mode || "auto";
      rotatorCfg.appearance.gradient.speed = th.gradient.speed || 3.2;
      rotatorCfg.appearance.gradient.direction = th.gradient.direction || "ltr";
      if (th.gradient.nightColors) rotatorCfg.appearance.gradient.nightColors = th.gradient.nightColors.slice();
      if (th.gradient.dayColors) rotatorCfg.appearance.gradient.dayColors = th.gradient.dayColors.slice();
    }
    return true;
  }

  /* ---------- 自定义短语行语法解析 (文案 | 权重 | when:... | rarity:...) ---------- */
  function parsePhraseLine(line) {
    var s = String(line || "").trim();
    if (!s || s.charAt(0) === "#") return null;
    var parts = s.split("|").map(function (p) { return p.trim(); });
    var text = parts[0];
    if (!text) return null;
    var item = { text: text, weight: 1 };
    for (var i = 1; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg) continue;
      if (/^\d+(?:\.\d+)?$/.test(seg)) {
        item.weight = clampNum(Number(seg), 0.1, 100, 1);
      } else if (seg.indexOf("rarity:") === 0) {
        item.rarity = clampNum(Number(seg.slice(7)), 0.01, 1, 1);
      } else if (seg.indexOf("when:") === 0) {
        var condStr = seg.slice(5).trim();
        var when = {};
        condStr.split(",").forEach(function (kv) {
          var eq = kv.indexOf("=");
          if (eq < 0) {
            var k0 = kv.trim();
            if (k0 === "tool" || k0 === "retry" || k0 === "pending" || k0 === "firstTurn") when[k0] = true;
          } else {
            var k = kv.slice(0, eq).trim(), v = kv.slice(eq + 1).trim();
            if (v === "true") when[k] = true;
            else if (v === "false") when[k] = false;
            else if (/^\d+$/.test(v) && (k === "retry" || k === "pending")) when[k] = parseInt(v, 10);
            else when[k] = v;
          }
        });
        if (Object.keys(when).length) item.when = when;
      }
    }
    return item;
  }

  function formatPhraseLines(list) {
    if (!Array.isArray(list)) return "";
    return list.map(function (it) {
      if (typeof it === "string") return it;
      if (!it || typeof it.text !== "string") return "";
      var segs = [it.text];
      if (typeof it.weight === "number" && it.weight !== 1) segs.push(String(it.weight));
      if (it.when && typeof it.when === "object") {
        var ws = [];
        for (var k in it.when) {
          if (Object.prototype.hasOwnProperty.call(it.when, k)) ws.push(k + "=" + it.when[k]);
        }
        if (ws.length) segs.push("when:" + ws.join(","));
      }
      if (typeof it.rarity === "number" && it.rarity < 1) segs.push("rarity:" + it.rarity);
      return segs.join(" | ");
    }).filter(Boolean).join("\n");
  }

  /* ---------- 词池合并、条件过滤、洗牌袋防重复与 17 个实时占位符 ---------- */
  function getMergedPhrasePool(phase, lang, nowDate) {
    var loc = lang === "en" ? "en" : "zh";
    var ph = (phase === "thinking" || phase === "long") ? phase : "running";
    var pool = [];
    var enabled = rotatorCfg.enabledPacks || [];
    if (rotatorCfg.scheduleEnabled) {
      var eff = resolveEffectiveRotatorConfig(nowDate);
      var effPreset = eff && eff.activePresetId && ZU_ROTATOR_BUILTIN_PRESETS[eff.activePresetId];
      if (effPreset && Array.isArray(effPreset.enabledPacks) && effPreset.enabledPacks.length) enabled = effPreset.enabledPacks;
    }
    for (var i = 0; i < enabled.length; i++) {
      var pack = ZU_ROTATOR_BUILTIN_PACKS[enabled[i]];
      if (!pack) continue;
      var locPack = pack[loc] || pack.zh || pack;
      var arr = locPack && Array.isArray(locPack[ph]) ? locPack[ph] : [];
      for (var j = 0; j < arr.length; j++) {
        var entry = arr[j];
        if (typeof entry === "string") pool.push({ text: entry, weight: 1, pack: enabled[i] });
        else if (entry && typeof entry.text === "string") pool.push(Object.assign({ weight: 1, pack: enabled[i] }, entry));
      }
    }
    var customLoc = rotatorCfg.customPhrases && rotatorCfg.customPhrases[loc];
    var customArr = customLoc && Array.isArray(customLoc[ph]) ? customLoc[ph] : [];
    for (var k = 0; k < customArr.length; k++) {
      var c = customArr[k];
      if (typeof c === "string") {
        var parsed = parsePhraseLine(c);
        if (parsed) pool.push(Object.assign({ pack: "custom" }, parsed));
      } else if (c && typeof c.text === "string") {
        pool.push(Object.assign({ weight: 1, pack: "custom" }, c));
      }
    }
    if (!pool.length) {
      pool.push({
        text: loc === "en"
          ? (ph === "thinking" ? "Thinking deeply ({elapsed})..." : ph === "long" ? "Still working hard ({elapsed})..." : "Generating response ({tps} t/s)...")
          : (ph === "thinking" ? "深度思考中（{elapsed}）…" : ph === "long" ? "长线攻坚中（{elapsed}）…" : "全力生成中（{tps} t/s）…"),
        weight: 1, pack: "fallback"
      });
    }
    return pool;
  }

  function matchesPhraseWhen(when, ctx) {
    if (!when || typeof when !== "object") return true;
    if (when.phase && when.phase !== ctx.phase) return false;
    if (when.tool !== undefined) {
      if (typeof when.tool === "boolean") {
        if (when.tool !== !!ctx.runningToolName) return false;
      } else if (typeof when.tool === "string") {
        if (!ctx.runningToolName || ctx.runningToolName.toLowerCase().indexOf(when.tool.toLowerCase()) < 0) return false;
      }
    }
    if (when.retry !== undefined) {
      if (typeof when.retry === "boolean" && when.retry !== (ctx.retryCount > 0)) return false;
      if (typeof when.retry === "number" && ctx.retryCount < when.retry) return false;
    }
    if (when.pending !== undefined) {
      if (typeof when.pending === "boolean" && when.pending !== (ctx.pendingCount > 0)) return false;
      if (typeof when.pending === "number" && ctx.pendingCount < when.pending) return false;
    }
    if (when.firstTurn !== undefined && !!when.firstTurn !== !!ctx.firstTurn) return false;
    if (when.hour !== undefined && !matchHourWindow(when.hour, ctx.hour)) return false;
    return true;
  }

  var recentPickedRing = [];
  try {
    if (rotatorCfg.antiRepeat && rotatorCfg.antiRepeat.persist) {
      var savedMem = JSON.parse(ls(ZU_ROTATOR_MEM_KEY, "[]"));
      if (Array.isArray(savedMem)) recentPickedRing = savedMem.slice(-50);
    }
  } catch (e) { }

  function pickRotatorPhrase(phase, ctx) {
    var rawPool = getMergedPhrasePool(phase, state.lang, ctx && ctx.now);
    var eligible = rawPool.filter(function (item) {
      if (!matchesPhraseWhen(item.when, ctx)) return false;
      if (typeof item.rarity === "number" && item.rarity > 0 && item.rarity < 1) {
        if (Math.random() > item.rarity) return false;
      }
      return true;
    });
    if (!eligible.length) eligible = rawPool;
    var limit = Math.min(
      (rotatorCfg.antiRepeat && typeof rotatorCfg.antiRepeat.recentLimit === "number") ? rotatorCfg.antiRepeat.recentLimit : 6,
      Math.max(0, eligible.length - 1)
    );
    var filtered = limit > 0 ? eligible.filter(function (it) {
      return recentPickedRing.slice(-limit).indexOf(it.text) < 0;
    }) : eligible;
    if (!filtered.length) filtered = eligible;

    var chosen = filtered[0];
    if (rotatorCfg.weightedRandom) {
      var totalW = 0;
      for (var i = 0; i < filtered.length; i++) totalW += Math.max(0.05, Number(filtered[i].weight) || 1);
      var r = Math.random() * totalW;
      for (var j = 0; j < filtered.length; j++) {
        r -= Math.max(0.05, Number(filtered[j].weight) || 1);
        if (r <= 0) { chosen = filtered[j]; break; }
      }
    } else {
      chosen = filtered[Math.floor(Math.random() * filtered.length)];
    }
    if (chosen && chosen.text) {
      recentPickedRing.push(chosen.text);
      if (recentPickedRing.length > 50) recentPickedRing.shift();
      if (rotatorCfg.antiRepeat && rotatorCfg.antiRepeat.persist) {
        lsSet(ZU_ROTATOR_MEM_KEY, JSON.stringify(recentPickedRing));
      }
    }
    return chosen ? chosen.text : "";
  }

  function formatRotatorElapsed(ms) {
    var sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (sec < 60) return sec + "s";
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + "m " + s + "s";
  }

  function formatRotatorPlaceholders(template, ctx) {
    if (!template) return "";
    var now = ctx.now || new Date();
    var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
    var dateStr = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
    var timeStr = pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());
    var phaseLabels = {
      thinking: L("深度思考", "Thinking"),
      running: L("全力输出", "Generating"),
      long: L("长线攻坚", "Deep work")
    };
    var map = {
      elapsed: formatRotatorElapsed(ctx.elapsedMs),
      phase: ctx.phase || "running",
      phaseLabel: phaseLabels[ctx.phase] || phaseLabels.running,
      model: ctx.model || "AI",
      provider: ctx.provider || "ZCode",
      tps: (typeof ctx.tps === "number" && isFinite(ctx.tps) && ctx.tps > 0) ? ctx.tps.toFixed(1) : "—",
      pending: String(ctx.pendingCount || 0),
      tools: String(ctx.toolsCount || 0),
      running: ctx.runningToolVerb || phaseLabels[ctx.phase] || phaseLabels.running,
      retry: String(ctx.retryCount || 0),
      retryMax: String(ctx.retryMax || 3),
      retryProvider: ctx.retryProvider || ctx.provider || "API",
      retryCode: ctx.retryCode || "429",
      detail: ctx.detail || "",
      locale: state.lang === "en" ? "en" : "zh",
      date: dateStr,
      time: timeStr
    };
    return String(template).replace(/\{(elapsed|phase|phaseLabel|model|provider|tps|pending|tools|running|retry|retryMax|retryProvider|retryCode|detail|locale|date|time)\}/g, function (_, k) {
      return map[k] !== undefined ? map[k] : "";
    });
  }

  /* ---------- 外观样式表（日夜自适应流光渐变、5 套主题预设、小鲸鱼尾巴、弹幕层） ---------- */
  var rotatorStyleEl = document.createElement("style");
  rotatorStyleEl.className = "zu-rotator-style";
  function resolveRotatorGradientColors() {
    var gr = rotatorCfg.appearance && rotatorCfg.appearance.gradient;
    if (!gr) return ["#ff6b6b", "#feca57", "#48dbfb", "#ff9ff3", "#54a0ff"];
    var isDark = true;
    try { isDark = document.documentElement.classList.contains("dark"); } catch (e) { }
    var useNight = gr.mode === "night" ? true : gr.mode === "day" ? false : isDark;
    var list = useNight ? gr.nightColors : gr.dayColors;
    return (Array.isArray(list) && list.length >= 2) ? list : ["#ff6b6b", "#feca57", "#48dbfb", "#ff9ff3", "#54a0ff"];
  }

  function updateRotatorStylesheet() {
    var ap = rotatorCfg.appearance || {};
    var gr = ap.gradient || {};
    var colors = resolveRotatorGradientColors();
    var loopColors = colors.concat([colors[0]]).join(",");
    var speed = clampNum(gr.speed, 0.5, 20, 3.2);
    var dir = gr.direction === "rtl" ? "to left" : "to right";
    var fontRule = ap.fontSizePx > 0 ? "font-size:" + ap.fontSizePx + "px!important;" : "";
    var weightRule = ap.fontWeight ? "font-weight:" + ap.fontWeight + "!important;" : "";
    var glowRule = ap.glow ? "filter:drop-shadow(0 0 6px " + (ap.glowColor || "rgba(87,200,255,.45)") + ");" : "";
    var animRule = ap.animation === "breathe"
      ? "animation:zuRotBreathe 2.4s ease-in-out infinite;"
      : ap.animation === "glitch"
      ? "animation:zuRotGlitch 1.8s steps(2,end) infinite;"
      : "";
    var gradCss = gr.enabled !== false
      ? "background-image:linear-gradient(" + dir + "," + loopColors + ")!important;" +
        "background-size:200% auto!important;-webkit-background-clip:text!important;background-clip:text!important;" +
        "color:transparent!important;-webkit-text-fill-color:transparent!important;" +
        "animation:zuRotFlow " + speed + "s linear infinite" + (ap.animation === "breathe" ? ",zuRotBreathe 2.4s ease-in-out infinite" : ap.animation === "glitch" ? ",zuRotGlitch 1.8s steps(2,end) infinite" : "") + "!important;"
      : animRule;

    rotatorStyleEl.textContent =
      "@keyframes zuRotFlow{0%{background-position:0% 50%}100%{background-position:200% 50%}}" +
      "@keyframes zuRotBreathe{0%,100%{opacity:.98;transform:scale(1)}50%{opacity:.72;transform:scale(.99)}}" +
      "@keyframes zuRotGlitch{0%,92%,100%{transform:translate(0,0);opacity:1}94%{transform:translate(-1px,.5px);opacity:.88}96%{transform:translate(1px,-.5px);opacity:.92}98%{transform:translate(-.5px,0);opacity:.85}}" +
      "@keyframes zuRotSpin{to{transform:rotate(360deg)}}" +
      "@keyframes zuRotBarPulse{0%,100%{transform:scaleY(.45);opacity:.55}50%{transform:scaleY(1);opacity:1}}" +
      "@keyframes zuDanmakuScroll{from{transform:translate3d(0,0,0)}to{transform:translate3d(var(--zu-dm-dist,-1400px),0,0)}}" +
      ".zu-rotator-active-label{" + fontRule + weightRule + glowRule + gradCss + "transition:opacity .15s ease}" +
      ".zu-rotator-bar{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:7px;cursor:pointer;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-rotator-bar:hover{background:var(--color-hover,rgba(255,255,255,.06))}" +
      ".zu-whale-tail-wrap{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:0 0 16px;vertical-align:middle}" +
      ".zu-whale-tail{width:16px;height:16px;display:block;overflow:visible}" +
      (rotatorCfg.whaleTailRainbow
        ? ".zu-whale-tail path{fill:url(#zu-whale-tail-grad)!important}"
        : ".zu-whale-tail path{fill:currentColor!important}") +
      ".zu-rot-spinner-ring{display:inline-block;width:12px;height:12px;border:1.8px solid currentColor;border-right-color:transparent;border-radius:50%;animation:zuRotSpin .75s linear infinite;flex:0 0 auto}" +
      ".zu-rot-spinner-bar{display:inline-flex;align-items:center;gap:1.5px;height:12px;flex:0 0 auto}" +
      ".zu-rot-spinner-bar i{display:inline-block;width:2px;height:10px;background:currentColor;border-radius:1px;animation:zuRotBarPulse .9s ease-in-out infinite}" +
      ".zu-rot-spinner-bar i:nth-child(2){animation-delay:.18s}.zu-rot-spinner-bar i:nth-child(3){animation-delay:.36s}" +
      ".zu-rotator-danmaku{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:2147483640}" +
      ".zu-rotator-danmaku[data-paused='1'] .zu-dm-item{animation-play-state:paused!important}" +
      ".zu-dm-item{position:absolute;white-space:nowrap;font-family:var(--font-mono,monospace);font-weight:600;line-height:1.35;" +
      "padding:2px 10px;border-radius:999px;text-shadow:0 1px 3px rgba(0,0,0,.65);pointer-events:auto;user-select:none;" +
      "transition:opacity .18s ease,transform .18s ease;will-change:transform}" +
      ".zu-dm-item.zu-dm-scroll{left:100%;animation:zuDanmakuScroll var(--zu-dm-dur,9s) linear forwards}" +
      ".zu-dm-item.zu-dm-fixed{left:50%;transform:translateX(-50%)}" +
      ".zu-dm-item:hover{z-index:5;background:rgba(15,18,25,.82);box-shadow:0 4px 14px rgba(0,0,0,.45)}" +
      ".zu-dm-HoverPause .zu-dm-item:hover{animation-play-state:paused!important}" +
      ".zu-dm-copy{display:none;margin-left:6px;padding:0 6px;border-radius:999px;border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.12);color:#fff;font-size:11px;cursor:pointer;line-height:1.4}" +
      ".zu-dm-item:hover .zu-dm-copy{display:inline-block}" +
      ".zu-rot-pack-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px;padding:6px 12px 10px}" +
      ".zu-rot-pack-item{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 10px;border:1px solid var(--color-border,rgba(255,255,255,.08));border-radius:8px;font-size:calc(var(--ui-font-size,14px) - 1px);cursor:pointer}" +
      ".zu-rot-pack-item small{color:var(--color-foreground-subtle,#8791a3);font-size:11px}" +
      ".zu-rot-textarea{width:calc(100% - 24px);margin:4px 12px 10px;min-height:74px;background:var(--color-input,rgba(0,0,0,.22));border:1px solid var(--color-border,rgba(255,255,255,.12));border-radius:8px;color:inherit;padding:6px 10px;font-family:var(--font-mono,monospace);font-size:calc(var(--ui-font-size,14px) - 2px);resize:vertical;box-sizing:border-box}" +
      ".zu-rot-inline-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 12px 10px}" +
      ".zu-rot-select,.zu-rot-num{background:var(--color-input,rgba(0,0,0,.22));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;color:inherit;padding:3px 8px;font:inherit;font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-rot-num{width:76px;text-align:right}" +
      ".zu-rot-btn{background:var(--color-hover,rgba(255,255,255,.08));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;color:inherit;padding:4px 10px;font:inherit;font-size:calc(var(--ui-font-size,14px) - 1px);cursor:pointer}" +
      ".zu-rot-btn:hover{background:var(--color-border,rgba(255,255,255,.16))}";
  }
  function ensureRotatorStyleMounted() {
    try {
      if (!rotatorStyleEl.parentElement && document.body) document.body.appendChild(rotatorStyleEl);
    } catch (e) { }
  }
  updateRotatorStylesheet();

  /* ---------- 弹幕引擎（scroll / top / bottom + 悬停暂停 + 点击复制 + 遮罩暂停） ---------- */
  var danmakuLayer = null;
  var activeDanmakus = [];
  var danmakuLaneUntil = { scroll: [], top: [], bottom: [] };

  function ensureDanmakuLayer() {
    if (danmakuLayer && danmakuLayer.isConnected) {
      danmakuLayer.classList.toggle("zu-dm-HoverPause", !!(rotatorCfg.danmaku && rotatorCfg.danmaku.hoverPause));
      return danmakuLayer;
    }
    try {
      danmakuLayer = document.createElement("div");
      danmakuLayer.className = "zu-rotator-danmaku" + (rotatorCfg.danmaku && rotatorCfg.danmaku.hoverPause ? " zu-dm-HoverPause" : "");
      document.body.appendChild(danmakuLayer);
    } catch (e) { danmakuLayer = null; }
    return danmakuLayer;
  }

  function isFullscreenMaskActive() {
    try {
      var dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-state="open"]');
      for (var i = 0; i < dialogs.length; i++) {
        var el = dialogs[i];
        if (el.classList && (el.classList.contains("zusage-panel") || el.classList.contains("zu-mp-ov"))) continue;
        var r = el.getBoundingClientRect();
        if (r.width > 120 && r.height > 80) return true;
      }
    } catch (e) { }
    return false;
  }

  function pickDanmakuMode(modesCfg) {
    var m = modesCfg || { scroll: 70, top: 15, bottom: 15 };
    var ws = Math.max(0, Number(m.scroll) || 0);
    var wt = Math.max(0, Number(m.top) || 0);
    var wb = Math.max(0, Number(m.bottom) || 0);
    var sum = ws + wt + wb;
    if (sum <= 0) return "scroll";
    var r = Math.random() * sum;
    if (r < ws) return "scroll";
    if (r < ws + wt) return "top";
    return "bottom";
  }

  function sendRotatorDanmaku(text, phaseOverride) {
    var dmCfg = rotatorCfg.danmaku || {};
    var msg = String(text || "").trim();
    if (!msg) return false;
    if (dmCfg.pauseBehindMask && isFullscreenMaskActive()) return false;
    var layer = ensureDanmakuLayer();
    if (!layer) return false;
    activeDanmakus = activeDanmakus.filter(function (item) { return item.el && item.el.isConnected; });
    if (activeDanmakus.length >= (dmCfg.maxConcurrent || 18)) return false;

    var mode = pickDanmakuMode(dmCfg.modes);
    var now = Date.now();
    var vh = Math.max(360, window.innerHeight || 720);
    var vw = Math.max(480, window.innerWidth || 1024);
    var laneHeight = 32;
    var maxLanes = Math.max(3, Math.floor((vh * 0.65) / laneHeight));
    var lanes = danmakuLaneUntil[mode] || (danmakuLaneUntil[mode] = []);
    var chosenLane = -1;
    for (var l = 0; l < maxLanes; l++) {
      if (!lanes[l] || lanes[l] <= now) { chosenLane = l; break; }
    }
    if (chosenLane < 0) chosenLane = Math.floor(Math.random() * maxLanes);
    var durSec = clampNum(dmCfg.speedSec, 3, 25, 9);
    lanes[chosenLane] = now + (mode === "scroll" ? Math.round(durSec * 320) : Math.round(durSec * 550));

    var el = document.createElement("div");
    el.className = "zu-dm-item " + (mode === "scroll" ? "zu-dm-scroll" : "zu-dm-fixed");
    var fontPx = Math.round(dmCfg.minFontPx + Math.random() * Math.max(0, (dmCfg.maxFontPx || 18) - (dmCfg.minFontPx || 13)));
    el.style.fontSize = fontPx + "px";
    el.style.opacity = String(clampNum(dmCfg.opacity, 0.1, 1.0, 0.88));

    var ph = phaseOverride || rotatorRuntime.lastPhase || "running";
    var palette = dmCfg.phaseColors
      ? (ph === "thinking" ? ["#a78bfa", "#38bdf8", "#818cf8"] : ph === "long" ? ["#fbbf24", "#fb7185", "#f97316"] : ["#34d399", "#38bdf8", "#60a5fa"])
      : resolveRotatorGradientColors();
    el.style.color = palette[Math.floor(Math.random() * palette.length)] || "#38bdf8";

    if (mode === "scroll") {
      el.style.top = (48 + chosenLane * laneHeight) + "px";
      el.style.setProperty("--zu-dm-dur", durSec + "s");
      el.style.setProperty("--zu-dm-dist", "-" + (vw + 640) + "px");
    } else if (mode === "top") {
      el.style.top = (48 + chosenLane * laneHeight) + "px";
    } else {
      el.style.bottom = (96 + chosenLane * laneHeight) + "px";
    }

    var textSpan = document.createElement("span");
    textSpan.textContent = msg;
    el.appendChild(textSpan);

    if (dmCfg.clickCopy) {
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "zu-dm-copy";
      copyBtn.textContent = L("复制", "Copy");
      copyBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(msg);
          copyBtn.textContent = L("已复制", "Copied");
        } catch (e) { }
      });
      el.appendChild(copyBtn);
    }

    layer.appendChild(el);
    var timer = setTimeout(function () {
      try { el.remove(); } catch (e) { }
    }, Math.round((mode === "scroll" ? durSec : durSec * 0.6) * 1000) + 200);
    activeDanmakus.push({ el: el, timer: timer });
    return true;
  }

  /* ---------- 窗口标题轮播所有权守卫 ---------- */
  var titleState = {
    hostBaseTitle: "",
    lastWrittenTitle: ""
  };

  function syncRotatorWindowTitle(active, ctx) {
    try {
      if (typeof document.title !== "string") return;
      if (document.title !== titleState.lastWrittenTitle) {
        titleState.hostBaseTitle = document.title;
      }
      if (!rotatorCfg.enabled || !rotatorCfg.title || !rotatorCfg.title.enabled) {
        if (titleState.lastWrittenTitle && document.title === titleState.lastWrittenTitle && titleState.hostBaseTitle) {
          document.title = titleState.hostBaseTitle;
        }
        titleState.lastWrittenTitle = "";
        return;
      }
      if (!active) {
        var idleTpl = rotatorCfg.title.idleTemplate ? formatRotatorPlaceholders(rotatorCfg.title.idleTemplate, ctx) : "";
        var targetIdle = idleTpl || titleState.hostBaseTitle;
        if (targetIdle && document.title !== targetIdle) {
          document.title = targetIdle;
          titleState.lastWrittenTitle = idleTpl ? targetIdle : "";
        }
        return;
      }
      var tpl = (rotatorCfg.title.templates && rotatorCfg.title.templates[ctx.phase]) || "{phaseLabel} ({elapsed}) · {model}";
      var nextTitle = formatRotatorPlaceholders(tpl, ctx);
      if (nextTitle && document.title !== nextTitle) {
        document.title = nextTitle;
        titleState.lastWrittenTitle = nextTitle;
      }
    } catch (e) { }
  }

  /* ---------- 运行态驱动：短语轮播、打字机、小鲸鱼尾巴动画与双挂载点同步 ---------- */
  var rotatorRuntime = {
    active: false,
    lastPhase: "thinking",
    rawPhrase: "",
    renderedPhrase: "",
    displayedText: "",
    typeChars: [],
    typeIndex: 0,
    lastPickAt: 0,
    lastTypeAt: 0,
    lastToolName: "",
    currentTailAction: "wag",
    tailFrameIndex: 0,
    tailBridgeQueue: [],
    lastTailStepAt: 0
  };

  function resolveCurrentTailAction() {
    var wm = rotatorCfg.whaleTailMotion || {};
    var act = wm.action || "wag";
    if (act !== "random") {
      rotatorRuntime.currentTailAction = act;
      return act;
    }
    var pool = Array.isArray(wm.randomActions) && wm.randomActions.length ? wm.randomActions : ["wag", "sway", "twist", "official"];
    if (pool.indexOf(rotatorRuntime.currentTailAction) < 0) {
      rotatorRuntime.currentTailAction = pool[Math.floor(Math.random() * pool.length)] || "wag";
    }
    return rotatorRuntime.currentTailAction;
  }

  function switchWhaleTailAction(nextAction) {
    var curAct = rotatorRuntime.currentTailAction || "wag";
    var curPoses = decodeWhaleTailPoses(curAct);
    var fromPath = curPoses[rotatorRuntime.tailFrameIndex % curPoses.length] || curPoses[0];
    rotatorRuntime.currentTailAction = nextAction;
    rotatorRuntime.tailFrameIndex = 0;
    var nextPoses = decodeWhaleTailPoses(nextAction);
    var toPath = nextPoses[0];
    rotatorRuntime.tailBridgeQueue = whaleTailBridgeFrames(fromPath, toPath).slice(1, -1);
  }

  function currentWhaleTailPath(nowMs, currentTps) {
    var wm = rotatorCfg.whaleTailMotion || {};
    var act = resolveCurrentTailAction();
    var poses = decodeWhaleTailPoses(act);
    if (!poses || !poses.length) return "M0 0 Z";
    if (wm.enabled === false) return poses[0];
    var hz = resolveWhaleTailSpeedHz(wm, currentTps, act);
    var frameIntervalMs = Math.max(12, Math.round(1000 / (hz * poses.length)));
    if (!rotatorRuntime.lastTailStepAt || nowMs - rotatorRuntime.lastTailStepAt >= frameIntervalMs) {
      rotatorRuntime.lastTailStepAt = nowMs;
      if (rotatorRuntime.tailBridgeQueue && rotatorRuntime.tailBridgeQueue.length) {
        return rotatorRuntime.tailBridgeQueue.shift();
      }
      rotatorRuntime.tailFrameIndex = (rotatorRuntime.tailFrameIndex + 1) % poses.length;
    }
    return poses[rotatorRuntime.tailFrameIndex % poses.length] || poses[0];
  }

  function whaleTailSvgHtml(pathD) {
    var colors = resolveRotatorGradientColors();
    return '<span class="zu-whale-tail-wrap" aria-hidden="true">' +
      '<svg class="zu-whale-tail" viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="zu-whale-tail-grad" x1="0%" y1="0%" x2="100%" y2="100%">' +
      '<stop offset="0%" stop-color="' + (colors[0] || "#38bdf8") + '"/>' +
      '<stop offset="50%" stop-color="' + (colors[1] || "#a78bfa") + '"/>' +
      '<stop offset="100%" stop-color="' + (colors[2] || colors[0] || "#f472b6") + '"/>' +
      '</linearGradient></defs>' +
      '<path d="' + (pathD || "M0 0 Z") + '"/></svg></span>';
  }

  function spinnerHtml() {
    var sp = rotatorCfg.appearance && rotatorCfg.appearance.spinner;
    if (sp === "ring") return '<span class="zu-rot-spinner-ring" aria-hidden="true"></span>';
    if (sp === "bar") return '<span class="zu-rot-spinner-bar" aria-hidden="true"><i></i><i></i><i></i></span>';
    return "";
  }

  function restoreChatLoadingRow(row) {
    if (!row) return;
    try {
      var label = row.querySelector(".zcode-loading-label");
      if (label && label.hasAttribute("data-zu-host-label")) {
        label.textContent = label.getAttribute("data-zu-host-label") || "";
        label.removeAttribute("data-zu-host-label");
        label.classList.remove("zu-rotator-active-label");
      }
      var pixelGrid = row.querySelector("span.grid");
      if (pixelGrid && pixelGrid.style.display === "none") pixelGrid.style.display = "";
      row.querySelectorAll(".zu-whale-tail-wrap,.zu-rot-spinner-ring,.zu-rot-spinner-bar").forEach(function (el) { el.remove(); });
      row.removeAttribute("data-zusage-rotator-slot");
    } catch (e) { }
  }

  function restoreAllChatLoadingRows() {
    try {
      document.querySelectorAll('[data-testid="chat-loading"],[data-zusage-rotator-slot]').forEach(restoreChatLoadingRow);
    } catch (e) { }
  }

  function syncChatMountSurface(active, displayStr, tailPath) {
    var wantChat = rotatorCfg.enabled && (rotatorCfg.mountTarget === "chat" || rotatorCfg.mountTarget === "both");
    if (!wantChat || !active) {
      restoreAllChatLoadingRows();
      return;
    }
    try {
      var rows = document.querySelectorAll('[data-testid="chat-loading"]');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        row.setAttribute("data-zusage-rotator-slot", "1");
        var label = row.querySelector(".zcode-loading-label");
        if (label) {
          var curText = label.textContent || "";
          if (!label.hasAttribute("data-zu-host-label") || (curText && curText !== rotatorRuntime.displayedText)) {
            if (!label.hasAttribute("data-zu-host-label")) label.setAttribute("data-zu-host-label", curText);
          }
          if (rotatorCfg.labelSource === "phrases" && displayStr) {
            if (label.textContent !== displayStr) label.textContent = displayStr;
          } else if (rotatorCfg.labelSource === "host" && label.hasAttribute("data-zu-host-label")) {
            var hostText = label.getAttribute("data-zu-host-label") || "";
            if (hostText && label.textContent !== hostText) label.textContent = hostText;
          }
          label.classList.add("zu-rotator-active-label");
        }
        var pixelGrid = row.querySelector("span.grid");
        var existingTail = row.querySelector(".zu-whale-tail-wrap");
        if (rotatorCfg.whaleTail) {
          if (pixelGrid) pixelGrid.style.display = "none";
          if (!existingTail) {
            var temp = document.createElement("div");
            temp.innerHTML = whaleTailSvgHtml(tailPath);
            existingTail = temp.firstChild;
            row.insertBefore(existingTail, row.firstChild);
          } else {
            var pathEl = existingTail.querySelector("path");
            if (pathEl && pathEl.getAttribute("d") !== tailPath) pathEl.setAttribute("d", tailPath);
          }
        } else {
          if (existingTail) existingTail.remove();
          if (pixelGrid && pixelGrid.style.display === "none") pixelGrid.style.display = "";
        }
      }
    } catch (e) { }
  }

  function syncBarMountSurface(active, displayStr, tailPath) {
    var wantBar = rotatorCfg.enabled && (rotatorCfg.mountTarget === "bar" || rotatorCfg.mountTarget === "both");
    var showInBar = wantBar && (active || rotatorCfg.barAlwaysShow);
    try {
      var bars = document.querySelectorAll(".zusage-root .zu-main");
      for (var i = 0; i < bars.length; i++) {
        var mainEl = bars[i];
        var pill = mainEl.querySelector(".zu-rotator-bar");
        if (!showInBar) {
          if (pill) pill.remove();
          continue;
        }
        if (!pill) {
          pill = document.createElement("span");
          pill.className = "zu-rotator-bar";
          pill.title = L("点击切换下一条轮播语", "Click for next rotating status phrase");
          pill.addEventListener("click", function (ev) {
            ev.stopPropagation();
            forceNextRotatorPhrase();
          });
          mainEl.insertBefore(pill, mainEl.firstChild);
        }
        var textToRender = displayStr || (rotatorRuntime.displayedText) || L("状态轮播就绪", "Status rotator ready");
        var iconHtml = rotatorCfg.whaleTail ? whaleTailSvgHtml(tailPath) : spinnerHtml();
        var nextInner = iconHtml + '<span class="zu-rotator-active-label">' +
          String(textToRender).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</span>';
        var tailPathEl = pill.querySelector(".zu-whale-tail path");
        var labelEl = pill.querySelector(".zu-rotator-active-label");
        if (rotatorCfg.whaleTail && tailPathEl && labelEl) {
          if (tailPathEl.getAttribute("d") !== tailPath) tailPathEl.setAttribute("d", tailPath);
          if (labelEl.textContent !== textToRender) labelEl.textContent = textToRender;
        } else {
          pill.innerHTML = nextInner;
        }
      }
    } catch (e) { }
  }

  function collectRotatorLiveContext() {
    var nowMs = Date.now();
    var nowDate = new Date(nowMs);
    var activeStats = null, model = "", provider = "ZCode", sess = null;
    for (var i = 0; i < instances.length; i++) {
      var inst = instances[i];
      var st = inst.rotatorStats && inst.rotatorStats();
      if (st && st.stats && !st.stats.complete) {
        activeStats = st.stats;
        model = st.model || model;
        provider = st.provider || provider;
        sess = st.session || sess;
        break;
      }
      if (st && !model && st.model) {
        model = st.model;
        provider = st.provider || provider;
        sess = st.session || sess;
      }
    }
    var domChatLoading = null;
    try { domChatLoading = document.querySelector('[data-testid="chat-loading"]'); } catch (e) { }
    var isRunning = !!(activeStats && !activeStats.complete) || !!domChatLoading;
    var startedAt = (activeStats && activeStats.startedAt) || (rotatorRuntime.turnStartedAt) || nowMs;
    if (isRunning && !rotatorRuntime.active) {
      rotatorRuntime.turnStartedAt = (activeStats && activeStats.startedAt) || nowMs;
      startedAt = rotatorRuntime.turnStartedAt;
    } else if (!isRunning) {
      rotatorRuntime.turnStartedAt = 0;
    }
    var elapsedMs = isRunning ? Math.max(0, nowMs - startedAt) : 0;
    var phase = "running";
    if (elapsedMs >= (rotatorCfg.longAfterMs || 30000)) phase = "long";
    else if ((activeStats && activeStats.phase === "thinking" && !activeStats.runningTool && !activeStats.characterRate) || elapsedMs < 15000) phase = "thinking";

    var tps = 0;
    if (activeStats && typeof activeStats.characterRate === "number" && activeStats.characterRate > 0) {
      tps = activeStats.characterRate / 2;
    } else if (sess && typeof sess.avg_tps === "number" && sess.avg_tps > 0) {
      tps = sess.avg_tps;
    }
    var runningToolName = activeStats && activeStats.runningTool && activeStats.runningTool.name ? activeStats.runningTool.name : "";
    var runningToolVerb = runningToolName ? zuToolVerb(runningToolName) : "";

    return {
      now: nowDate,
      nowMs: nowMs,
      active: isRunning,
      phase: phase,
      elapsedMs: elapsedMs,
      model: model || (state.data && state.data.session && state.data.session.model) || "AI",
      provider: provider || "ZCode",
      tps: tps,
      runningToolName: runningToolName,
      runningToolVerb: runningToolVerb,
      toolsCount: (sess && sess.tool_calls) || 0,
      retryCount: (sess && sess.retries) || 0,
      retryMax: 3,
      pendingCount: 0,
      firstTurn: !sess || (sess.turns || 0) <= 1,
      hour: nowDate.getHours(),
      detail: runningToolVerb
    };
  }

  function forceNextRotatorPhrase(ctxOverride) {
    var ctx = ctxOverride || collectRotatorLiveContext();
    var raw = pickRotatorPhrase(ctx.phase, ctx);
    rotatorRuntime.rawPhrase = raw;
    rotatorRuntime.renderedPhrase = formatRotatorPlaceholders(raw, ctx);
    rotatorRuntime.typeChars = Array.from(rotatorRuntime.renderedPhrase);
    if (!rotatorCfg.typeSpeedMs || rotatorCfg.typeSpeedMs <= 0) {
      rotatorRuntime.typeIndex = rotatorRuntime.typeChars.length;
      rotatorRuntime.displayedText = rotatorRuntime.renderedPhrase;
    } else {
      rotatorRuntime.typeIndex = Math.min(1, rotatorRuntime.typeChars.length);
      rotatorRuntime.displayedText = rotatorRuntime.typeChars.slice(0, rotatorRuntime.typeIndex).join("");
    }
    rotatorRuntime.lastPickAt = ctx.nowMs;
    rotatorRuntime.lastTypeAt = ctx.nowMs;
    if (rotatorCfg.danmaku && rotatorCfg.danmaku.enabled && (ctx.active || ctxOverride)) {
      sendRotatorDanmaku(rotatorRuntime.renderedPhrase, ctx.phase);
    }
    return rotatorRuntime.renderedPhrase;
  }

  function rotatorMasterTick() {
    if (stale()) return;
    try {
      ensureRotatorStyleMounted();
      var ctx = collectRotatorLiveContext();
      var wasActive = rotatorRuntime.active;
      rotatorRuntime.active = ctx.active;

      if (rotatorCfg.danmaku && rotatorCfg.danmaku.pauseBehindMask && danmakuLayer) {
        danmakuLayer.setAttribute("data-paused", isFullscreenMaskActive() ? "1" : "0");
      }

      // Check tool switch for whale tail random action
      if (ctx.runningToolName && ctx.runningToolName !== rotatorRuntime.lastToolName) {
        rotatorRuntime.lastToolName = ctx.runningToolName;
        var wm = rotatorCfg.whaleTailMotion || {};
        if (rotatorCfg.whaleTail && wm.enabled && wm.action === "random" && wm.toolSwitchEnabled) {
          if (Math.random() < (typeof wm.toolSwitchChance === "number" ? wm.toolSwitchChance : 0.65)) {
            var pool = Array.isArray(wm.randomActions) && wm.randomActions.length ? wm.randomActions : ["wag", "sway", "twist", "official"];
            var candidates = pool.filter(function (a) { return a !== rotatorRuntime.currentTailAction; });
            var nextAct = (candidates.length ? candidates : pool)[Math.floor(Math.random() * (candidates.length || pool.length))] || "wag";
            switchWhaleTailAction(nextAct);
          }
        }
      } else if (!ctx.runningToolName) {
        rotatorRuntime.lastToolName = "";
      }

      if (ctx.active || rotatorCfg.barAlwaysShow) {
        var phaseChanged = ctx.phase !== rotatorRuntime.lastPhase;
        rotatorRuntime.lastPhase = ctx.phase;
        if (!wasActive || phaseChanged || !rotatorRuntime.rawPhrase || (ctx.nowMs - rotatorRuntime.lastPickAt >= rotatorCfg.intervalMs)) {
          forceNextRotatorPhrase(ctx);
        } else {
          // Live update dynamic placeholders ({elapsed}, {tps}) once typing completes
          var reRendered = formatRotatorPlaceholders(rotatorRuntime.rawPhrase, ctx);
          if (rotatorRuntime.typeIndex >= rotatorRuntime.typeChars.length) {
            rotatorRuntime.renderedPhrase = reRendered;
            rotatorRuntime.displayedText = reRendered;
          } else if (rotatorCfg.typeSpeedMs > 0 && ctx.nowMs - rotatorRuntime.lastTypeAt >= rotatorCfg.typeSpeedMs) {
            var steps = Math.max(1, Math.floor((ctx.nowMs - rotatorRuntime.lastTypeAt) / rotatorCfg.typeSpeedMs));
            rotatorRuntime.typeIndex = Math.min(rotatorRuntime.typeChars.length, rotatorRuntime.typeIndex + steps);
            rotatorRuntime.displayedText = rotatorRuntime.typeChars.slice(0, rotatorRuntime.typeIndex).join("");
            rotatorRuntime.lastTypeAt = ctx.nowMs;
          }
        }
      }

      var tailPath = rotatorCfg.whaleTail ? currentWhaleTailPath(ctx.nowMs, ctx.tps) : "";
      syncChatMountSurface(ctx.active, rotatorRuntime.displayedText, tailPath);
      syncBarMountSurface(ctx.active, rotatorRuntime.displayedText, tailPath);
      syncRotatorWindowTitle(ctx.active, ctx);
    } catch (e) {
      FATAL.rotatorErr = String((e && e.stack) || e);
    }
  }

  var lastRotatorFrameAt = 0;
  function rotatorFrameStep() {
    var now = Date.now();
    if (now - lastRotatorFrameAt < 65) return;
    lastRotatorFrameAt = now;
    rotatorMasterTick();
  }

  /* ---------- 设置面板「状态轮播」(data-sec="rotator") UI 与事件委托 ---------- */
  function zuRotatorSectionHtml() {
    var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
    var packChecks = ZU_ROTATOR_PACK_META.map(function (pm) {
      var pack = ZU_ROTATOR_BUILTIN_PACKS[pm.id];
      var locPack = pack && (pack[state.lang === "en" ? "en" : "zh"] || pack.zh || pack);
      var cnt = locPack ? ((locPack.thinking ? locPack.thinking.length : 0) + (locPack.running ? locPack.running.length : 0) + (locPack.long ? locPack.long.length : 0)) : 0;
      var checked = (rotatorCfg.enabledPacks || []).indexOf(pm.id) >= 0 ? " checked" : "";
      return '<label class="zu-rot-pack-item"><span><input type="checkbox" class="zu-rot-pack-cb" data-pack="' + pm.id + '"' + checked + '> ' +
        esc(L(pm.zh, pm.en)) + '</span><small>' + cnt + '</small></label>';
    }).join("");

    var loc = state.lang === "en" ? "en" : "zh";
    var customThink = formatPhraseLines(rotatorCfg.customPhrases && rotatorCfg.customPhrases[loc] && rotatorCfg.customPhrases[loc].thinking);
    var customRun = formatPhraseLines(rotatorCfg.customPhrases && rotatorCfg.customPhrases[loc] && rotatorCfg.customPhrases[loc].running);
    var customLong = formatPhraseLines(rotatorCfg.customPhrases && rotatorCfg.customPhrases[loc] && rotatorCfg.customPhrases[loc].long);

    return '<section class="zu-settings-section" data-sec="rotator"' + (activeSettingsSec() === "rotator" ? "" : " hidden") + '>' +
      '<div class="cap">' + L("状态轮播与小鲸鱼动画", "Status Rotator & Whale Tail") + '</div>' +
      '<div class="zu-settings-card">' +
        settingRow('<input type="checkbox" class="zu-rot-enable">', L("启用状态轮播", "Enable status rotator"), L("在模型思考/生成/长耗时期间轮播趣味状态短语，支持 17 种实时统计占位符（如 {elapsed}、{tps}、{model}）。", "Rotates witty status phrases during thinking, generating and long turns with 17 live placeholders ({elapsed}, {tps}, {model}, etc.).")) +
        '<div class="zu-rot-inline-row">' +
          '<span>' + L("轮播挂载位置", "Mount target") + '</span>' +
          '<select class="zu-rot-select zu-rot-mount">' +
            '<option value="both">' + L("同时开启（消息流 + 状态条）", "Both (Chat loading + Status bar)") + '</option>' +
            '<option value="chat">' + L("仅消息流 Loading 行", "Chat loading row only") + '</option>' +
            '<option value="bar">' + L("仅状态条内轮播格", "Status bar cell only") + '</option>' +
          '</select>' +
          '<label><input type="checkbox" class="zu-rot-bar-always"> ' + L("状态条常驻预览", "Always show in bar") + '</label>' +
        '</div>' +
        '<div class="zu-rot-inline-row">' +
          '<span>' + L("文案来源", "Label source") + '</span>' +
          '<select class="zu-rot-select zu-rot-source">' +
            '<option value="phrases">' + L("趣味词库轮播", "Phrase packs") + '</option>' +
            '<option value="host">' + L("保留宿主原生文案（仅套用外观与鲸鱼尾巴）", "Host label (appearance & whale tail only)") + '</option>' +
          '</select>' +
          '<span>' + L("轮播间隔(ms)", "Interval (ms)") + '</span>' +
          '<input type="number" class="zu-rot-num zu-rot-interval" min="500" max="60000" step="100">' +
          '<span>' + L("打字机(ms/字)", "Typewriter (ms)") + '</span>' +
          '<input type="number" class="zu-rot-num zu-rot-typespeed" min="0" max="200" step="5">' +
          '<button type="button" class="zu-rot-btn zu-rot-next-btn">' + L("🎲 换一条", "🎲 Next phrase") + '</button>' +
        '</div>' +
      '</div>' +

      '<div class="cap">' + L("DeepSeek 小鲸鱼摇尾巴 SVG 帧动画（<100KB 压缩引擎）", "DeepSeek Whale Tail SVG Animation (<100KB)") + '</div>' +
      '<div class="zu-settings-card">' +
        settingRow('<input type="checkbox" class="zu-rot-whaletail">', L("显示小鲸鱼尾巴图标", "Show whale tail SVG icon"), L("替换原生加载像素点并在状态条轮播格前展示 DeepSeek 小鲸鱼尾巴 SVG 动画（150 帧流畅循环 + 6 帧轮廓桥接过渡，体积压缩至 ~75KB）。", "Replaces the loading indicator with the 150-frame DeepSeek whale tail SVG animation (~75KB compressed with 6-frame contour morphing).")) +
        settingRow('<input type="checkbox" class="zu-rot-whalerainbow">', L("尾巴炫彩流光填充", "Rainbow gradient fill on whale tail"), L("开启后小鲸鱼尾巴跟随流光渐变色；关闭后跟随当前文字颜色。", "Fills the whale tail with the active flowing gradient; off uses currentColor.")) +
        '<div class="zu-rot-inline-row">' +
          '<span>' + L("摆尾动作", "Tail motion") + '</span>' +
          '<select class="zu-rot-select zu-rot-tail-action">' +
            '<option value="random">' + L("随机切换（含 6 帧平滑过渡）", "Random (with 6-frame smooth morph)") + '</option>' +
            '<option value="wag">' + L("翻转摆尾 (wag)", "Flip wag (wag)") + '</option>' +
            '<option value="sway">' + L("左右摆尾 (sway)", "Side sway (sway)") + '</option>' +
            '<option value="twist">' + L("扭转摆尾 (twist)", "3D twist (twist)") + '</option>' +
            '<option value="official">' + L("官方原版晃动 (official)", "Official wobble (official)") + '</option>' +
          '</select>' +
          '<span>' + L("摆尾调速", "Speed mode") + '</span>' +
          '<select class="zu-rot-select zu-rot-tail-speedmode">' +
            '<option value="tps">' + L("随实时 TPS 档位加速", "Scale with live TPS") + '</option>' +
            '<option value="fixed">' + L("固定频率 (Hz)", "Fixed frequency (Hz)") + '</option>' +
          '</select>' +
          '<label><input type="checkbox" class="zu-rot-tail-toolswitch"> ' + L("工具调用时随机换动作", "Switch action on tool call") + '</label>' +
        '</div>' +
      '</div>' +

      '<div class="cap">' + L("流光外观与主题预设", "Flowing Gradient & Appearance Themes") + '</div>' +
      '<div class="zu-settings-card">' +
        '<div class="zu-rot-inline-row">' +
          '<span>' + L("外观主题", "Theme preset") + '</span>' +
          '<select class="zu-rot-select zu-rot-theme">' +
            Object.keys(ZU_APPEARANCE_THEMES).map(function (k) {
              var t = ZU_APPEARANCE_THEMES[k];
              return '<option value="' + k + '">' + esc(L(t.zh, t.en)) + '</option>';
            }).join("") +
          '</select>' +
          '<label><input type="checkbox" class="zu-rot-grad-enable"> ' + L("启用日夜自适应流光渐变", "Day/Night adaptive flowing gradient") + '</label>' +
          '<span>' + L("流光方向", "Direction") + '</span>' +
          '<select class="zu-rot-select zu-rot-grad-dir">' +
            '<option value="ltr">' + L("从左到右", "Left to right") + '</option>' +
            '<option value="rtl">' + L("从右到左", "Right to left") + '</option>' +
          '</select>' +
          '<span>' + L("动效", "Animation") + '</span>' +
          '<select class="zu-rot-select zu-rot-anim">' +
            '<option value="none">' + L("无", "None") + '</option>' +
            '<option value="breathe">' + L("呼吸脉冲", "Breathe") + '</option>' +
            '<option value="glitch">' + L("故障抖动", "Glitch") + '</option>' +
          '</select>' +
        '</div>' +
        settingRow('<input type="checkbox" class="zu-rot-title-enable">', L("同步轮播窗口标题 (document.title)", "Rotate window title"), L("仅在回合进行中更新窗口标题，回合结束或插件卸载时自动还原宿主原始标题。", "Updates window title during active turns and restores the host title when idle.")) +
      '</div>' +

      '<div class="cap">' + L("实时弹幕引擎", "Live Danmaku Engine") + '</div>' +
      '<div class="zu-settings-card">' +
        settingRow('<input type="checkbox" class="zu-rot-dm-enable">', L("开启状态弹幕", "Enable danmaku overlay"), L("每次轮播切换时在屏幕发射弹幕（支持滚动/顶部/底部权重分配、悬停暂停并复制、全屏弹窗自动暂停）。", "Fires danmaku across the viewport on phrase rotation (scroll/top/bottom weights, hover-to-pause & copy, auto-pause behind modals).")) +
        '<div class="zu-rot-inline-row">' +
          '<label><input type="checkbox" class="zu-rot-dm-hover"> ' + L("悬停暂停", "Hover pause") + '</label>' +
          '<label><input type="checkbox" class="zu-rot-dm-copy"> ' + L("悬停显示复制按钮", "Click to copy") + '</label>' +
          '<label><input type="checkbox" class="zu-rot-dm-phase"> ' + L("按阶段着色", "Phase colors") + '</label>' +
          '<input type="text" class="zu-rot-select zu-rot-dm-testinput" placeholder="' + L("输入测试弹幕内容…", "Test danmaku text…") + '" style="flex:1;min-width:140px">' +
          '<button type="button" class="zu-rot-btn zu-rot-dm-sendbtn">' + L("🚀 发射测试弹幕", "🚀 Fire danmaku") + '</button>' +
        '</div>' +
      '</div>' +

      '<div class="cap">' + L("14 个内置词包与排程预设", "14 Built-in Phrase Packs & Presets") + '</div>' +
      '<div class="zu-settings-card">' +
        '<div class="zu-rot-inline-row">' +
          '<span>' + L("场景预设", "Scene preset") + '</span>' +
          '<select class="zu-rot-select zu-rot-preset">' +
            Object.keys(ZU_ROTATOR_BUILTIN_PRESETS).map(function (k) {
              var pr = ZU_ROTATOR_BUILTIN_PRESETS[k];
              return '<option value="' + k + '">' + esc(L(pr.zh, pr.en)) + '</option>';
            }).join("") +
          '</select>' +
          '<button type="button" class="zu-rot-btn zu-rot-packs-all">' + L("全选词包", "Select all") + '</button>' +
          '<button type="button" class="zu-rot-btn zu-rot-packs-default">' + L("恢复默认词包", "Default packs") + '</button>' +
          '<label><input type="checkbox" class="zu-rot-schedule-enable"> ' + L("按工作时段/深夜自动切换预设", "Auto-switch preset by schedule") + '</label>' +
        '</div>' +
        '<div class="zu-rot-pack-grid">' + packChecks + '</div>' +
      '</div>' +

      '<div class="cap">' + L("自定义短语（每行一条，支持：文案 | 权重 | when:tool=Bash | rarity:0.5）", "Custom Phrases (one per line: text | weight | when:tool=Bash | rarity:0.5)") + '</div>' +
      '<div class="zu-settings-card">' +
        '<div class="pnote">' + L("思考阶段 (thinking)", "Thinking phase") + '</div>' +
        '<textarea class="zu-rot-textarea zu-rot-custom-thinking" placeholder="' + L("正在思考人生 ({elapsed})… | 2", "Thinking deeply ({elapsed})… | 2") + '">' + esc(customThink) + '</textarea>' +
        '<div class="pnote">' + L("运行阶段 (running)", "Running phase") + '</div>' +
        '<textarea class="zu-rot-textarea zu-rot-custom-running" placeholder="' + L("全力输出中 {tps} t/s · {running} | 2", "Streaming at {tps} t/s · {running} | 2") + '">' + esc(customRun) + '</textarea>' +
        '<div class="pnote">' + L("长耗时阶段 (long)", "Long turn phase") + '</div>' +
        '<textarea class="zu-rot-textarea zu-rot-custom-long" placeholder="' + L("已经苦战 {elapsed}，稳住能赢！ | 3", "Still working after {elapsed}, hang tight! | 3") + '">' + esc(customLong) + '</textarea>' +
      '</div>' +
    '</section>';
  }

  function zuRotatorSyncPanel(panelEl) {
    if (!panelEl) return;
    var q = function (sel) { return panelEl.querySelector(sel); };
    var setCb = function (sel, val) { var el = q(sel); if (el) el.checked = !!val; };
    var setVal = function (sel, val) { var el = q(sel); if (el) el.value = String(val); };

    setCb(".zu-rot-enable", rotatorCfg.enabled);
    setVal(".zu-rot-mount", rotatorCfg.mountTarget);
    setCb(".zu-rot-bar-always", rotatorCfg.barAlwaysShow);
    setVal(".zu-rot-source", rotatorCfg.labelSource);
    setVal(".zu-rot-interval", rotatorCfg.intervalMs);
    setVal(".zu-rot-typespeed", rotatorCfg.typeSpeedMs);

    setCb(".zu-rot-whaletail", rotatorCfg.whaleTail);
    setCb(".zu-rot-whalerainbow", rotatorCfg.whaleTailRainbow);
    setVal(".zu-rot-tail-action", rotatorCfg.whaleTailMotion.action);
    setVal(".zu-rot-tail-speedmode", rotatorCfg.whaleTailMotion.speedMode);
    setCb(".zu-rot-tail-toolswitch", rotatorCfg.whaleTailMotion.toolSwitchEnabled);

    setVal(".zu-rot-theme", rotatorCfg.appearance.theme);
    setCb(".zu-rot-grad-enable", rotatorCfg.appearance.gradient.enabled);
    setVal(".zu-rot-grad-dir", rotatorCfg.appearance.gradient.direction);
    setVal(".zu-rot-anim", rotatorCfg.appearance.animation);
    setCb(".zu-rot-title-enable", rotatorCfg.title.enabled);

    setCb(".zu-rot-dm-enable", rotatorCfg.danmaku.enabled);
    setCb(".zu-rot-dm-hover", rotatorCfg.danmaku.hoverPause);
    setCb(".zu-rot-dm-copy", rotatorCfg.danmaku.clickCopy);
    setCb(".zu-rot-dm-phase", rotatorCfg.danmaku.phaseColors);

    setVal(".zu-rot-preset", rotatorCfg.activePreset);
    setCb(".zu-rot-schedule-enable", rotatorCfg.scheduleEnabled);

    panelEl.querySelectorAll(".zu-rot-pack-cb").forEach(function (cb) {
      cb.checked = (rotatorCfg.enabledPacks || []).indexOf(cb.getAttribute("data-pack")) >= 0;
    });
  }

  function zuRotatorPanelClick(e, panelEl) {
    var t = e.target;
    if (!t || !t.closest) return false;
    if (t.closest(".zu-rot-next-btn")) {
      var phrase = forceNextRotatorPhrase();
      rotatorMasterTick();
      if (rotatorCfg.danmaku && rotatorCfg.danmaku.enabled) sendRotatorDanmaku(phrase);
      return true;
    }
    if (t.closest(".zu-rot-dm-sendbtn")) {
      var inp = panelEl.querySelector(".zu-rot-dm-testinput");
      var txt = (inp && inp.value && inp.value.trim()) || forceNextRotatorPhrase();
      sendRotatorDanmaku(txt, rotatorRuntime.lastPhase);
      return true;
    }
    if (t.closest(".zu-rot-packs-all")) {
      rotatorCfg.enabledPacks = ZU_ROTATOR_PACK_META.map(function (m) { return m.id; });
      saveRotatorConfig();
      zuRotatorSyncPanel(panelEl);
      forceNextRotatorPhrase();
      return true;
    }
    if (t.closest(".zu-rot-packs-default")) {
      rotatorCfg.enabledPacks = ZU_ROTATOR_DEFAULT_PACKS.slice();
      saveRotatorConfig();
      zuRotatorSyncPanel(panelEl);
      forceNextRotatorPhrase();
      return true;
    }
    return false;
  }

  function zuRotatorPanelChange(e, panelEl) {
    var t = e.target;
    if (!t || !t.classList) return false;
    var cl = t.classList;
    if (cl.contains("zu-rot-enable")) { rotatorCfg.enabled = !!t.checked; }
    else if (cl.contains("zu-rot-mount")) { rotatorCfg.mountTarget = t.value; }
    else if (cl.contains("zu-rot-bar-always")) { rotatorCfg.barAlwaysShow = !!t.checked; }
    else if (cl.contains("zu-rot-source")) { rotatorCfg.labelSource = t.value; }
    else if (cl.contains("zu-rot-interval")) { rotatorCfg.intervalMs = clampNum(t.value, 500, 60000, 3500); }
    else if (cl.contains("zu-rot-typespeed")) { rotatorCfg.typeSpeedMs = clampNum(t.value, 0, 200, 28); }
    else if (cl.contains("zu-rot-whaletail")) { rotatorCfg.whaleTail = !!t.checked; }
    else if (cl.contains("zu-rot-whalerainbow")) { rotatorCfg.whaleTailRainbow = !!t.checked; }
    else if (cl.contains("zu-rot-tail-action")) {
      rotatorCfg.whaleTailMotion.action = t.value;
      if (t.value !== "random") switchWhaleTailAction(t.value);
    }
    else if (cl.contains("zu-rot-tail-speedmode")) { rotatorCfg.whaleTailMotion.speedMode = t.value; }
    else if (cl.contains("zu-rot-tail-toolswitch")) { rotatorCfg.whaleTailMotion.toolSwitchEnabled = !!t.checked; }
    else if (cl.contains("zu-rot-theme")) {
      applyAppearanceThemePreset(t.value);
      zuRotatorSyncPanel(panelEl);
    }
    else if (cl.contains("zu-rot-grad-enable")) { rotatorCfg.appearance.gradient.enabled = !!t.checked; }
    else if (cl.contains("zu-rot-grad-dir")) { rotatorCfg.appearance.gradient.direction = t.value; }
    else if (cl.contains("zu-rot-anim")) { rotatorCfg.appearance.animation = t.value; }
    else if (cl.contains("zu-rot-title-enable")) { rotatorCfg.title.enabled = !!t.checked; }
    else if (cl.contains("zu-rot-dm-enable")) { rotatorCfg.danmaku.enabled = !!t.checked; }
    else if (cl.contains("zu-rot-dm-hover")) { rotatorCfg.danmaku.hoverPause = !!t.checked; }
    else if (cl.contains("zu-rot-dm-copy")) { rotatorCfg.danmaku.clickCopy = !!t.checked; }
    else if (cl.contains("zu-rot-dm-phase")) { rotatorCfg.danmaku.phaseColors = !!t.checked; }
    else if (cl.contains("zu-rot-preset")) {
      applyRotatorPreset(t.value);
      zuRotatorSyncPanel(panelEl);
    }
    else if (cl.contains("zu-rot-schedule-enable")) { rotatorCfg.scheduleEnabled = !!t.checked; }
    else if (cl.contains("zu-rot-pack-cb")) {
      var pid = t.getAttribute("data-pack");
      var list = (rotatorCfg.enabledPacks || []).slice();
      var idx = list.indexOf(pid);
      if (t.checked && idx < 0) list.push(pid);
      else if (!t.checked && idx >= 0) list.splice(idx, 1);
      rotatorCfg.enabledPacks = list;
    }
    else if (cl.contains("zu-rot-custom-thinking") || cl.contains("zu-rot-custom-running") || cl.contains("zu-rot-custom-long")) {
      var loc = state.lang === "en" ? "en" : "zh";
      var ph = cl.contains("zu-rot-custom-thinking") ? "thinking" : cl.contains("zu-rot-custom-long") ? "long" : "running";
      rotatorCfg.customPhrases[loc][ph] = String(t.value || "").split(/\r?\n/).map(parsePhraseLine).filter(Boolean);
    } else {
      return false;
    }
    saveRotatorConfig();
    updateRotatorStylesheet();
    rotatorMasterTick();
    return true;
  }

  function zuRotatorDisposeAll() {
    restoreAllChatLoadingRows();
    try { if (rotatorStyleEl && rotatorStyleEl.remove) rotatorStyleEl.remove(); } catch (e) { }
    try { if (danmakuLayer && danmakuLayer.remove) danmakuLayer.remove(); danmakuLayer = null; } catch (e) { }
    try {
      document.querySelectorAll(".zu-rotator-bar,.zu-rotator-danmaku,.zu-rotator-style").forEach(function (el) { el.remove(); });
    } catch (e) { }
    activeDanmakus.forEach(function (d) { clearTimeout(d.timer); });
    activeDanmakus = [];
    if (titleState.lastWrittenTitle && document.title === titleState.lastWrittenTitle && titleState.hostBaseTitle) {
      try { document.title = titleState.hostBaseTitle; } catch (e) { }
    }
    if (window.__zusageRotatorDispose === zuRotatorDisposeAll) delete window.__zusageRotatorDispose;
    if (window.__zusageStatusRotator) delete window.__zusageStatusRotator;
  }
  window.__zusageRotatorDispose = zuRotatorDisposeAll;

  window.__zusageStatusRotator = {
    getConfig: function () { return JSON.parse(JSON.stringify(rotatorCfg)); },
    setConfig: function (patch) {
      if (!patch || typeof patch !== "object") return false;
      Object.assign(rotatorCfg, patch);
      saveRotatorConfig();
      rotatorCfg = loadRotatorConfig();
      updateRotatorStylesheet();
      rotatorMasterTick();
      return true;
    },
    nextPhrase: function () { return forceNextRotatorPhrase(); },
    sendDanmaku: function (text, phase) { return sendRotatorDanmaku(text, phase); },
    decodeWhaleTailPoses: decodeWhaleTailPoses,
    whaleTailBridgeFrames: whaleTailBridgeFrames,
    parsePhraseLine: parsePhraseLine,
    formatPlaceholders: formatRotatorPlaceholders,
    tailDataBytes: function () { return JSON.stringify(ZU_WHALE_TAIL_DATA).length; }
  };

  /* 设置页（MCP 配置等）内的编辑框不是聊天输入框：设置是同窗口覆盖层，激活时
   * 聊天视图保持挂载、仅 opacity-0+inert 视觉遮蔽——v61 幽灵判定管的是聊天壳，
   * 设置层是其兄弟节点、够不着。设置框架内（settings-page 根 testid 或
   * content/panel 双 frame 标记，三层标记并集排除、跨宿主版本覆盖面最大）的
   * JSON/环境变量文本框（MCP 表单展开「环境变量（可选）」后的 rows=4 文本框）
   * 落在视口下半部，会被协调器当聊天输入框派发，条冒在设置页底部（实测 bug）。
   * 带设置框架标记的候选一律不派发；聊天流（composer/权限面板/批准框）不在
   * 设置框架内，行为不受影响。 */
  function inSettingsView(el) {
    try { return !!(el.closest && el.closest('[data-testid="settings-page"],[data-settings-content-frame],[data-settings-panel-frame]')); } catch (e) { return false; }
  }
  function coordinator() {
    /* 协调器（v61.1）：扫描主文档里全部下半屏可见输入框，按 pane 键（data-pane-id，
     * 无属性回退 "auto"）分组派发给实例；一个 pane 一条，pane 消失对应条自藏。 */
    function paneKeyOf(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (p.hasAttribute && p.hasAttribute("data-pane-id")) return p.getAttribute("data-pane-id") || "auto";
      }
      return "auto";
    }
    function sessIdOf(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (p.hasAttribute && p.hasAttribute("data-session-id")) return p.getAttribute("data-session-id") || "";
      }
      return "";
    }
    /* v174：辅助对话（划词 side chat）候选识别。它复用主会话 SessionPane 组件：无外层
     * data-pane-id（paneKeyOf 落 "auto"、会被下方 v171 守卫丢弃），但会话根节点 testid
     * 恒为 "v4-session-pane-" + 宿主 tabId（tabId 以 selection-side-chat: 开头，三段
     * encodeURIComponent，3.17.1 asar 实证）；桥部署时同节点另写 data-zusage-pane-id=
     * tabId。返回宿主 tabId（同时作实例键与桥 scope 校验键），非辅助候选返回 ""。
     * 只认宿主自带标记，不从标题/最近邻猜身份。
     * v258：宿主 testid 与桥属性双缺席（表外客户端版本）时按 fiber 兜底——同文副本在
     * fiberSideIdOf（detOwnerOf 侧），两个源码切片测试的 eval 区间不相交，须同步改。 */
    function sidePaneKeyOf(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (!p.hasAttribute) continue;
        if (p.hasAttribute("data-zusage-pane-id")) {
          var zpid = p.getAttribute("data-zusage-pane-id");
          if (zpid && String(zpid).indexOf("selection-side-chat:") === 0 &&
              p.getAttribute("data-zusage-scope-version") === "1") return zpid;
        }
        if (p.hasAttribute("data-testid")) {
          var tid = String(p.getAttribute("data-testid"));
          if (tid.indexOf("v4-session-pane-selection-side-chat:") === 0) return tid.slice("v4-session-pane-".length);
        }
        if (p.getAttribute("data-zusage-scope-version") !== "1" && p.hasAttribute("data-session-id")) {
          var fiberHit = fiberSideIdOfPane(p);
          if (fiberHit) return fiberHit;
        }
      }
      return "";
    }
    /* v258：fiberSideIdOf 的 coordinator 局部同文副本（port-patches 切片 eval 边界）。
     * 与模块级版本唯一的差异是无外部引用，逻辑须与 fiberSideIdOf 逐字同规。 */
    function fiberSideIdOfPane(el) {
      try {
        var keys = Object.keys(el), fk = "";
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) { fk = keys[i]; break; }
        }
        if (!fk) return "";
        var fiber = el[fk], hit = "", depth = 0;
        while (fiber && depth++ < 24) {
          var node = fiber.stateNode;
          if (node && node !== el && node.getAttribute &&
              (node.hasAttribute("data-session-id") || node.hasAttribute("data-pane-id"))) break;
          var p = fiber.memoizedProps || fiber.pendingProps;
          if (p && typeof p.tabId === "string" && p.tabId.indexOf("selection-side-chat:") === 0) {
            if (hit && hit !== p.tabId) return "";
            hit = p.tabId;
          }
          fiber = fiber.return;
        }
        return hit;
      } catch (e) { return ""; }
    }
    var SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
    function candidateVisible(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        try {
          if (p.inert) return false;
          var cs = getComputedStyle(p);
          if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return false;
        } catch (e) { }   // 异常环境放行：track 的幽灵/遮挡判定仍会兜底
      }
      return true;
    }
    function tick() {
      if (stale()) return;
      try {
        var best = {};
        document.querySelectorAll(SEL).forEach(function (el) {
          if (el.closest && el.closest('[role="dialog"]')) return;   // v62：弹窗内的编辑框不是聊天输入框，不派实例（issue #9）
          if (inSettingsView(el)) return;   // 设置页（MCP 配置等）的编辑框不是聊天输入框，不派实例
          var r = el.getBoundingClientRect();
          if (!(r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < innerHeight)) return;
          if (!candidateVisible(el)) return;
          var nativeComposer = el.getAttribute && el.getAttribute("data-testid") === "v4-composer-input";
          try { nativeComposer = nativeComposer || !!el.closest('[data-testid^="v4-pane-shell-"]'); } catch (e) { }
          var k = sidePaneKeyOf(el) || paneKeyOf(el), attached = false;
          for (var n = 0; n < instances.length; n++) {
            if (instances[n].pid === k && instances[n].ownsComposer && instances[n].ownsComposer(el)) { attached = true; break; }
          }
          if (!nativeComposer && !attached && r.top < innerHeight * 0.45) return;
          if (!best[k] || (k === "auto" && nativeComposer && !best[k].nativeComposer) ||
              (nativeComposer === !!best[k].nativeComposer && r.top > best[k].top))
            best[k] = { el: el, top: r.top, nativeComposer: nativeComposer };
        });
        var keys = Object.keys(best);
        if (!keys.length) { best["auto"] = { el: null, top: 0 }; keys = ["auto"]; }   // shadow/iframe 兜底
        /* issue #147（社区 @Mc-GrowlR 报告并给出方案）：窗口里已有真实 pane 键（工作区分栏
         * 都带 data-pane-id）时，"auto" 键一律丢弃——无 pane 键的候选只可能是同窗子面
         * （3.17.x 划词 side chat，常驻挂载、收起后幽灵 composer 仍在），不是独立分栏；
         * 老宿主无 data-pane-id 时全部候选均为 auto（单键），单实例行为不变。
         * v174：辅助对话已在上方按宿主 tabId（selection-side-chat:…）独立成键，不再落
         * auto；此处丢弃的只剩真正无法识别的候选，防重守卫本身不变。 */
        if (keys.indexOf("auto") >= 0 && keys.length > 1 &&
            (!best.auto.nativeComposer || keys.some(function (k) { return k !== "auto" && k.indexOf("selection-side-chat:") !== 0; }))) {
          delete best["auto"];
          keys = Object.keys(best);
        }
        // 独立选择四主一辅，优先保留仍可见的既有实例，避免 DOM 顺序引发重建。
        var selected = [], mainCount = 0, sideCount = 0;
        instances.map(function (inst) { return inst.pid; }).concat(keys).forEach(function (k) {
          if (keys.indexOf(k) < 0 || selected.indexOf(k) >= 0) return;
          if (k.indexOf("selection-side-chat:") === 0) {
            if (sideCount >= 1) return;
            sideCount++;
          } else {
            if (mainCount >= 4) return;
            mainCount++;
          }
          selected.push(k);
        });
        keys = selected;
        instances = instances.filter(function (inst) {
          if (keys.indexOf(inst.pid) >= 0) return true;
          inst.dispose();
          return false;
        });
        keys.forEach(function (k) {
          var inst = null;
          for (var i = 0; i < instances.length; i++) if (instances[i].pid === k) { inst = instances[i]; break; }
          if (!inst) inst = spawnInstance(k, nextSlot++);
          if (inst) inst.attach(best[k].el, sessIdOf(best[k].el));
        });
        refreshWants();
        reportQuotaSelections();
        FATAL.insts = instances.map(function (a) { return a.pid + "=" + (a.getSid() ? a.getSid().slice(-8) : "-"); }).join(" | ");
      } catch (e) { FATAL.coordErr = String((e && e.stack) || e); }
    }
    tick();
    coordinatorTimer = setInterval(tick, 600);
  }







  /* ---------- 实例工厂（v61.1）：一个 pane 一套 条/面板/气泡/tooltip/定位循环。
   * slot 0 保留 #zusage-bar/#zusage-tip 兼容 id（泵热更新按它清理），其余实例仅类名。 */
  function spawnInstance(pid, slot) {
    var VERSION = "v275";   //v82 统计行锚点深度查找（新会话结构嵌套在 group/assistant-turn 内容列内）→ v83 万/亿单位开关（默认开、仅中文）+ K/M/B 的 B 档 → v84 主标签页远端路由（工作台分组唯一主绑定上报 + 迟到载荷守卫，issue #30）→ v85 回答末尾统计行跟随万/亿开关 + tok→token → v86 历史轮 tracker 无记录（窗口滑出/换代/热更）或缺输出字段不再翻成"本轮统计不可用"，加 det 诊断 → v87 主叶归属增 last-session 回退（组零证据时唯一远端记录放行，issue #30 复测：单会话主标签页不建组）→ v88 运行态心跳与两处扫描 tick 2s→0.5s（富文本重试 6→24 次等价放大）→ v89 ⚙ 面板更新进度：downloading 阶段文案 + 下载（字节）/安装（校验→安装→同步）双进度条，缺 progress 的旧主进程自动隐藏 → v90 主标签页/分栏归属改按本窗会话节点身份（renderer 桥按版本/资产/锚点写 SessionPane 属性，移除 workbench-groups/last-session 共享回退）+ 心跳 0.5s→0.1s（扫描维持 0.5s）→ v91 设置页/权限面板冒条修复（PR #44：inSettingsView 三处派发排除 + anchorCardOf 面板锚点改判）收编收尾：排除标记并集（settings-page testid + content/panel 双 frame）、track 显隐第四处防御 → v92 ⚙ 更新区固定显示可复制的重装口令（源码安装无法自动更新时引导用户发给 agent）→ v93 原生上下文按钮（chat-context-usage-trigger）增强：环填充/四档色/右侧百分比镜像状态条上下文格（ctxBandOf 同源），cw 缺失还原原生形态 → v94 状态条删除「上下文容量」格（UI+tooltip，该口径由原生按钮增强承载），⚙ 面板同步去掉「上下文」开关，子代理格改始终展示（零值也显示）→ v95 ⚙ 更新区去掉 v92 重装口令提示块（源码清单的仓库来源改由宿主插件管理器直接更新，不再报渠道不一致），更新来源文案增「仓库源码」分支→ v96 套餐额度 chip（默认关）：挂原生上下文按钮左侧（wrapper 内前插，与按钮增强同款双 reapply/还原），数据来自主进程 quota 字段（解密宿主 OAuth 凭据直查 monitor 端点，账号级套餐池口径），会话首个 main_turn 完成前不显示；自绘 tooltip 走 rateTip 独立浮层模式；chip 改多窗分段：每窗一段（中文 5小时/7天，英文 5h/7d）各自按 80/95/100 档位色，分隔符 |；余额类型单段渲染就绪（余额 ¥100.00，阶段 3 数据源接入即用）；去掉环形，容器不着色 → v97 子代理速率（T1+T2）：zusage sub 汇总加 rate_avg/每子代理 tps_avg（已完成段加权平均，口径同 _turn_rate），子代理格 tooltip/明细面板展示；Agent 运行期主 chip 附加「子代理运行中 · 估 X t/s」——turn-stats 透传 subagent 行 childSessionId，overlay 据此用同款 zuTryBindStore 绑子代理会话 store 做字符增量估算（运行中请求未入库，DB 无实时数据；150s 采样实锤零 running 行），思考文本不进 rows 时退回纯状态词；工具动词「正在运行子智能体」压成「子代理运行中」（web 同步文案）；同日多槽位化：turn-stats 暴露 runningSubagents 全集（并行时 rowId 前 8 个），每子代理独立绑定/2s 节流，主 chip 显示合计速率（并行 ≥2 时动词后缀 ×N），chip tooltip 与子代理明细面板逐个实时展示运行中估算（tooltip 随原地改字同步 __tip 重画；面板 800ms tick 原地刷新 .subrate，汇总页运行块含 DB 尚无记录的新子代理） → v98 额度实时选源恢复（v4-model-config 观察 + quota-providers 全窗快照上报 + byProvider 定向刷新、空选择 fail-closed）与 sub2api 额度 UI（今日/本月窗口、窗口行内金额明细、Key 总额度、订阅截止、账户余额标题） → v99（主线并流）tooltip 伪边界 leave 过滤：Chrome 悬停链收缩/重算会补发 DOM 内部的 documentElement/tip mouseleave，tipLeaveAt 贴边判定后取触发时刻最深 :hover 元素甄别，仍悬停在本档具体元素上即伪 leave 一律忽略交回 mousemove 流（主线 v100 滚动豁免=本链 v106 同义，不另列） → v99.1（主线并流）apiKey 模式 BigModel/Z.ai（bigmodel-api[-N]/zai-api[-N]）额度 chip 标题家族判定（issue #68；数据链在 quota-client） → v99.2 思考中计时随语言本地化（中文「1 时 2 分 3 秒」/英文「1 h 2 m 3 s」，空格分隔、零段照旧省略）；回答末尾行采样时刻改完整中文日期时间（⏱ 2026 年 10 月 23 日 11 点 20 分 28 秒，token_rate.py format_turn_line 同步改版） → v100 设置面板分区导航（ZCode 设置侧栏同款：左栏三组分区导航 + 内容区单分区显隐，激活项 aria-current="page"，选择持久化 zusage3.sec；面板窄于 620px 时导航收成 icon rail） → v101 设置面板高度在打开瞬间按内容自然高锁定（切分区不再抖动，resize 只收紧不放大） → v102 额度源预设模板（CC Switch/magpie 同款选模板只填 Key：官方域变体 chip 一键写入 secrets baseUrl，minimax 可信域机制推广到 siliconflow 币种随域；deepseek/openrouter/kimi/anthropic/mimo/volcano 附控制台取 Key 链接，走 openExternal 桥） → v103 额度源列表卡片化布局（每源圆角卡片+间距，凭据框限宽 420px，长说明段落补水平边距；纯 CSS，结构行为不变） → v104 源状态文案补 disabled=已关闭映射 + 主进程对显式关闭源统一报 disabled（修「开关已关却显示待查询」矛盾）；刷新/获取 Key 按钮补 title 提示，关闭源的刷新按钮禁用 → v105 「上下文容量」弹层（hover-card-content）内压缩上下文按钮：命中率行下方全宽胶囊按钮（原生 secondary 配色全走客户端语义变量），弹层关即卸载（Radix 无 forceMount）故 body MutationObserver + heavy 对账双触发、DOM 存在性幂等（多实例安全），插入锚=「剩余额度」border-t 段前（缺则容器尾）+位置兜回；点击弹原生 AlertDialog 视格确认框（遮罩/Esc/外点关闭、Enter 确认），确认后优先走 fiber 上原生残留的 onSendCompressionCommand("/compact")（SessionPane 压缩入口，不动输入框草稿），缺失回落官方 E2E 输入桥 __zcodeLexicalInputE2E.setText + 发送键（Lexical 直写 DOM 不生效，禁用该路径；草稿非空拒绝） → v106 额度 tooltip 滚动豁免：hideTipsOnScroll 不再收 quotaTip（chip 固定 composer 工具行与 gitTip 同理），修思考中流式输出自动滚动致悬停弹出即灭；chip 随宿主重建 detach（无 mouseleave）由 scanRateLines 加 isConnected 健康检查兜底收起 → v107 压缩确认框补行为提示：压缩进行中发送新消息/停止会打断压缩（实测 16:27 新 turn 启动同秒 compact turn TURN_CANCELLED，cancelled_by_user=1；引擎对该次摘要流挂起 134s 无首 token 也不重试 retryable=0），确认框加 hint 行中性告知 → v108 压缩主通道按用户指定改为字面 "/compact" 输入提交（E2E 桥 setText+发送键；流式中 v4-stop 可见/草稿非空/发送键 disabled 三重拒绝），fiber 命令信封降兜底；hint 升级为「通常需 2-4 分钟且无进度反馈」（DB 实证：全库 compact 请求无首 token 但正常完成，72s-9.6min，14:44 同会话同模型 165s 成功先例；16:25/16:43 两次「卡住」实为 2m20s 被新消息 TURN_CANCELLED，非故障） → v109 压缩主通道按用户指定改回直接调会话发送接口（fiber onSendCompressionCommand 命令信封：不碰输入框/发送键、流式中交引擎排队，修字面输入通道在生成中被发送键禁用卡住的问题），字面 "/compact" 输入提交降兜底（三重门控仅作用于兜底） → v110 压缩提交函数改在弹框打开瞬间（弹层必存活、锚点几何可信）解析并缓存，修复确认时弹层已被 Radix 卸载、几何重解析退化为「离视口左上角最近」致多分栏把 /compact 发进错误会话（P1）；兜底字面输入通道的流式/发送键/草稿三重门控全部前置到 setText 之前（拒绝不再残留草稿）；Enter 确认限定焦点在弹框内（无焦点陷阱下防焦点外 Enter 误触发确认） → v111 额度 chip 默认展示：quota_enabled 缺省开（显式 false 才关，真值链在 inject-main）；chip 二级门控 not_configured/unsupported 从静默隐藏改中性灰提示「额度 未配置/暂不支持」（源被 ⚙ 显式关闭仍隐藏），tooltip 补 info 分支引导配置 → v112 Start Plan 免费档池（quota-client 新增 zcode-start 适配器走 zcode.z.ai billing/balance 独立链，与 coding plan 的 monitor 端点分池；选源路由与 quotaFamily 判定补 start-plan 分支修 start-plan pane 误读 GLM Coding Max 池；chip 增「套餐」分段（windows.plan，one_time 发放池聚合已用%），tooltip 套餐池行按 expires 标记切「到期」措辞） → v113 夜间审计加固：quotaBalanceText 内建转义（currency 是远程响应字符串，chip/tooltip 双 innerHTML sink；parts label/amount 单次转义修双重转义；「其他源」行标签转义归位；aria-label 走 plain 纯文本变体不读实体）→quotaTip 补内容签名幂等 __zuTipSig（同 gitTip，悬停期间周期对账不再打断文本选择）→子代理明细面板数据签名幂等（滚动位置/选择不被每 1.5s 推送整面板重建重置；运行中估算仍由面板 800ms tick 原地刷新）→额度 chip 签名重写保留 zu-qbusy（点击刷新动画不被推送截断，同 git chip）→⚙ 源列表 id/label/preset/keyUrl 属性级转义 aEsc（custom:<providerId> 可含用户自定义名）→live 速度 span 的 speedView.text 过 ttEsc（工具名是宿主/MCP 可控字符串）→渲染桥两处订阅回调尾部 updateLive() try 包裹（异常不冒进宿主 store 通知分发，诊断键 subLiveErr/bridgeLiveErr 记录） → v114 积压清单清扫：remoteCache/remoteTodayCache/richTextCache/richTextAttempts 上限淘汰（长会话防无界增长）；dispose 清理补 __zusageDeliverTurnText/__zusageSidWs/__zusagePaneScopes（旧代闭包自卫之外的清理完整性）；诊断 lsVals 只转储 zusage 命名空间的 localStorage 键（宿主其余键值不进 diag 文件） → v115 渲染循环省电（上游 xhwxt PR #26/#28 同源问题）：幽灵子树/遮挡命中/模态判定加 TTL 缓存（120/150ms，命中绑定元素矩形+模式），track 在 document.hidden 时整帧跳过；未采纳其 600ms↔2s 调度降频（heavy 600ms 对账是与 render 并列的 React 重写兜底契约，降频会让增强节点裸奔 2s） → v116 「思考中」卡死修复（源码复核定案）：v87 合成分支条件收紧——仅「空窗口非终态（draft 空窗，v87 本意）或 control.phase=running」才合成思考中，删除「行非空」析取项（宿主 wire 快照 rows.window 恒为全序尾 60 行，末轮超窗的闲置会话整窗无 turnHeader，旧条件使其永久点亮思考中、切回重绑重新计时）；思考计时锚定 turnHeader.startedAt（宿主创建 header 恒写入，重绑不清零，缺字段回退首观测）→ v117 悬停命中区扩到整栏（fork lliangworld b21e3cf0 同源收编）：条目空隙/分隔符按 sep 中线就近归属、尾部空隙归末位条目，⚙ 与空条面维持保持不动；防闪烁改由节流+幂等承担 → v118 无障碍与主题重构（并行会话批次）：条目可聚焦（span tabindex / zu-sub 真按钮 + aria-label）、键盘可达 tooltip（focusin/focusout + Escape 收起）、focus-visible 焦点环、SVG 图标与思考动画改 currentColor 随主题、⚙ 面板请求-回执协议（requestId + __zusagePluginResult，feedbackVersion 1）、quota 源操作错误语义、统计行开关即时重扫 → v119 插件自动检查改为每 1 小时，更新区双语提示更新器变更需完全退出并重开 → v120 Git 手动刷新改请求-回执协议（askGitRefresh 带 path/requestId，主桥 gitTick 完成后经 __zusagePluginResult 回执、在途请求合并等待，按请求 path 校验结果）+ 状态条 aria-live sr-only 播报区（套餐额度查询中/Git 刷新状态）+ ⚙ 面板高度上限 82vh→90vh + 模态判定改按可见 dialog（display/visibility/opacity 过滤） → v121 状态条 .ico 与 ⚙ 齿轮图标盒由 calc(字号+4px) 改为等宿主字号（24 格线性图标墨迹只占盒 75–83%，18px 顶满 1.3 行盒显大，且加法常量令比例随字号漂移 1.33×→1.20×；用户实机定 1.0×，.eb .ico 12px 特例不变） → v122 Git chip 展开测量完整宽度并留 32px 迟滞余量，切断宿主 compact 反馈环（issue #100） → v123 Git chip 锚点按电脑操作→上下文→模式→思考回退，排除隐藏探针并随可见锚点迁移（issue #103） → v124 Git chip 固定左侧操作区，移除右侧上下文/思考回退 → v125 思考计时中文全紧邻「7分16秒」（时段间空格去除，用户要求；英文「7 m 16 s」不动） → v126 思考计时英文数字与单位紧邻「7m 16s」（时段间留空格，用户要求） → v127 tok/s 速度十档色（TPS_BANDS 唯一事实源，原始值分档含下限不含上限：<40 低速红 / 40–70 一般黄 / 70–150 流畅绿沿用原三档类名与实测色，150 起新增蓝紫系 zu-teal/zu-sky/zu-azure/zu-violet/zu-purple/zu-magenta，≥2000 Ultra 静态蓝紫渐变 + ✦ 星点（::before content:"✦"/"" AT 静音、@supports 外纯紫回退，浅色组同名覆盖渐变）；估算态与完成态同表分档（用户规格，原「估算态不分档」废止），无效值（负数/NaN/±∞）一律中性 dim 或回退 DB 绝不判低速，DB 回退分支负数/非有限不再渲染 chip；tooltip 档位行改动态「名称 · lo–hi t/s」消解 toFixed 舍入边界歧义，另加静态「颜色对照」图例（十档数值↔颜色升序一览，档位类与条面同源随主题切换）；额度正常态改额度蓝 #78a9ff/浅 #315fc4（.zu-qseg 专属基色，不碰全局 .ok——上下文与速度前三档仍绿），周期标签拆 zu-qlabel 子节点中性次级色常规字重（textContent/aria/tooltip 不变），quotaSegs 补 isFinite 门防 NaN/±∞ 落正常蓝；正常态再改 CCometixLine 同源柔和低饱和（用户规格）：普通窗灰蓝 #8abbd0/浅 #276f86、7 天窗按 quotaSegs 结构化 key 挂 zu-qweekly 淡紫 #b69ad8/浅 #76509f（不匹配显示文本），周期标签与数值同色成组仅标签降字重，上下文按钮正常绿改 #72c9a2/浅 #187b58（限按钮作用域，速度与全局 .ok 不动）） → v129 模型拉取分区（收编 HHQ-666/zcode-model-puller，MIT）：⚙ 基础组新分区列宿主 provider_config.json 的 API Key 型自定义供应商，经主进程拉取其 /models（候选端点探测、OpenAI data/Ollama models/顶层数组形状解析、Bearer+x-api-key 双头），弹窗勾选（已添加/新模型徽标、搜索过滤、全选/清空/仅选新、选中计数）后经 model-pull-apply 最小写回（personalModelIds+modelOrder 追加、providerModelRules 复制同供应商模板条目、同目录原子替换+滚动备份 .zusage-bak、未知键保留）；key 只在主进程内存、只发该 baseUrl 本域，不回渲染端不进日志；请求回执 20s 兜底超时（旧主进程无 action 时提示完全重启而非永久 loading） → v130 拉取算法吸收 GLQQX/zcode-model-discovery-patch 与 linguo2625469/zcode-patcher：字段别名全集（id/modelId/name/model、context_length/contextWindow/context_window/limit/limits、max_completion_tokens/max_output_tokens/maxOutputTokens/limit/limits/top_provider、payload 增 result 形状）、多模态感知（architecture.input_modalities/input_modalities/modalities.input + vision/supports_vision 布尔 ⇒ 宿主 inputFormat 稀疏能力位，缺位写实 false）、思考档位感知（supported_efforts 去重截 16 ⇒ reasoningLevel.values）、models.dev 公共目录补缺（并行拉取 5s 超时失败静默降级、id 精确→basename 唯一匹配、字段级供应商优先、key 与本机数据绝不发往目录、进程内 1h 缓存）、applyModels 按模型写实 config（contextWindow/inputFormat/optionSpecs；元数据走主进程 fetchCache 闭环、渲染端只回传 id 无法注入字段；模板带 map 表达式的 optionSpecs 整体不覆盖防 values 换名失配；无依据字段保持模板原样、不编造默认值）；弹窗行新增 ctx/out 可见小字与档位 title，分区说明补 models.dev 联网披露；review 修复：勾选表/已添加表/metaById 改 null 原型（模型 id 来自远端，__proto__ 等键静默失败丢勾选态）、实例 dispose 同步摘除模型拉取弹窗与 Esc 监听（原仅整体 dispose 摘除，pane 关闭后弹窗跨代泄漏且确认回调 inactive 早退卡保存中文案）、重开面板停在模型拉取分区时立即刷新列表、请求兜底超时 20s→25s（主进程最坏双端点 20s 防假超时）、主进程响应体 8MB 限长解析与 tmp 文件名带 pid 防双实例竞写 → v131 额度/上下文五档色（用户规格 2026-10-27）：CTX_BANDS/QUOTA_BANDS 唯一事实源（{min,cls} 有序表，bandOf 从高到低首个命中），阈值 30/50/80/90（含下限不含上限）——额度 calm/norm/mid/high/crit=emerald/sky/amber/orange/rose（暗 400/浅 700），上下文 calm/norm/mid/high/crit=slate/indigo/violet/orange/red；data-zusage-band 与 zu-qb-* CSS 双主题成对；pct span 与 SVG 环一律继承按钮 currentColor（.zu-ctxpct.ok 系独立色废止）；tabular-nums 原已覆盖 .zu-quota/.zu-ctxpct；v92 百万窗口提前预警（40/60）与 v127 额度正常态灰蓝/7 天窗淡紫（按窗口类型着色）随「仅按百分比」规格废止；额度 ≥100% 满档保留呼吸闪烁特效（zu-qb-exc，用户规格；90–99 为 crit 纯色）；压缩过程态（exc）优先档保留；余额/Key 额度段挂 calm 档色 → v132 模型拉取挂载点迁移（用户指令）：⚙ 设置分区删除（ZU_SECTIONS/section/ensureMpProviders/syncMpList/startMpFetch/mpFeedback 全撤），改挂官方「模型设置⇒自定义供应商」的「+ 添加模型」按钮左侧（锚 data-testid=model-provider-add-model-button，额度 chip 同款 enhance/restore 契约：render/heavy 双对账+位置兜回+自清选择器 .zu-mp-host）；供应商归属优先读设置页表单 http(s) Base URL 归一化匹配（唯一命中直拉），否则单供应商直用/多供应商弹 zu-mp-pick 选择列表/无供应商弹提示；按钮视觉复刻原生 secondary 视格（同页 Tailwind utility bg-secondary h-7 rounded-lg），⚡ 图标 stroke currentColor；弹窗抽通用壳 openMpShell（勾选弹窗/供应商选择/错误提示共用），apply 成功关弹窗由宿主自动刷新列表；供应商归属改主判定=当前选择的供应商（读宿主源码定案：导航项 testid=model-provider-nav-item-<nodeKey>、custom 项 nodeKey=custom:<providerId>、选中项 data-state=selected），providerId 精确匹配不受编辑草稿影响；Base URL 匹配降兜底（专用 testid model-provider-base-url-input 优先于表单启发式），弹窗对齐 HHQ 形态（⚡统计标题/搜索占位/仅选新模型计数/已选中 n 个模型/蓝实底确认钮）并自带 .zu-light 随宿主主题实时换装；review 二轮修复：上下文按钮浅色档补 data-zusage-armed 特异性（浅色主题 norm~crit 曾被暗色 0,3,0 规则恒胜）、model-puller 非 ok 响应体显式 cancel（undici 连接卫生）、宿主按钮 ml-auto（锚容器 justify-between 三子项均匀分布致按钮居中）、确认钮改固定蓝 #3B82F6/#2563EB（客户端 --color-brand 深色主题是白系，白底白字隐形）、拉取按钮仅在选中的是 custom 供应商时挂载（锚 testid 全局唯一，内置/套餐页同 testid）、拉取中按钮文本「拉取中…」+图标旋转（原透明度脉冲无感知） → v133 Git 计数缩写（用户规格 2026-10-28）：chip/tooltip 的行数·条目·↑↓·冲突计数 <1万原值，≥1万 中文（cnUnits 判定）万/亿、英文 k/M/B（k 门槛刻意抬到 1万，与 token fmt 的 K≥1000 不同，小写 k 至多两位小数去尾零紧邻）；仓库个数与 aria 播报保持原值 → v134 额度与上下文保留既有阈值并统一绿黄红三档视觉；统一字号为宿主基准减 1px，周期标签加粗并微调分隔符 → v136 编辑项目弹窗源文件夹行在名称下方显示完整路径（纯 CSS ::after attr(title)，零 DOM 注入 React 无感；.truncate 限定本地行、排除 fixedFolder break-all 全路径行防重复，多文件夹每行各取各的 title；长路径自动换行不做省略号（宿主 truncate 的 nowrap 继承进伪元素须显式 white-space:normal）；规则挂条样式表、由 <html> data-zusage-pp 门控，⚙ 通用区「项目完整路径」开关 zusage3.projPath 默认开即时生效；顺带清理未提交编辑遗留的 spawnInstance 陈旧重复块 566 行死代码并复原被覆写的 issue #55 注释） → v137 源文件夹行点击即用系统文件管理器打开该目录（用户规格 2026-10-28，mac/Win 双平台）：主通道宿主桥 openInFileManager（Windows shell.openPath / macOS open 带 Finder 与 shell 双回退，raw path 免编码），旧主进程降级 openExternalFile、openExternal(file:)（白名单含 file:）；远程项目编辑器按 virtual-project-existing 标记排除，fixedFolder 行不在选择器内；多 pane 重复委托 500ms 同路径去重，document click 监听随实例 dispose 摘除；行加 cursor:pointer → v138 重置卡倒计时改时分秒全档恒显（并行会话 rstmerge 线并流收编，用户规格 2026-10-28：精确到秒、随 600ms 对账实时逐秒跳动，rstSpanText 中文数字单位紧邻「3时05分30秒」、英文数字单位紧邻+时段间空格「3h 05m 30s」；rst tooltip 补 Escape 收起（v118 键盘可达契约）；⚙ 倒计时阈值语义不变——并流时保留 rstCdh 持久化，对方运行目录构建因旧基线缺失而误删，其 18:42 rstmerge 部署曾覆盖本项目 v136/v137 后经本线合并恢复） → v139 合并 fork/main v1.5.5 线（PR #121 重置卡徽标、#122 倒计时秒级、#123 templateRules 回填、安装修复与 v1.5.5 发版）时收编遗漏的 model-puller 套餐源判定（4e431cc：detectSelectedCustomProviderId 带 anchor，BigModel 付费套餐详情页按 GLM Coding Max 付费卡区分放行、Start Plan 免费卡页不放行；挂载门控 btn 先查 + mpAnchor 诊断）——本项目快照缺该段曾致 overlay-model-pull 挂载契约测试红；overlay 版本线自此与对方 v136 撞号线并流，按合入顺序顺延 → v140 收口审查修复：openProjFolder 对 invoke 通道（openInFileManager/openExternalFile）挂空 catch——旧主进程无 handler 时异步 reject 会刷 unhandled rejection；review-fix-merge 流程产物 → v141 ⚙ 更新区在 API 限流且渠道清单兜底也失败时引导 GitCode 镜像口令（清单兜底本体在 plugin-updater/plugin-release 主进程链） → v142 ⚙ 通用「状态条样式」双主题 opt-in（zusage3.theme 独立持久化，默认关=现状）：药丸形态=所属输入卡下方居中、内容定宽，.zu-pill 经 --zu-pill-* 逐项拷贝所属视觉表面（Highspeed 外壳优先）计算样式，随宿主主题/hover/focus/Highspeed 实时跟随——pillSurface 统一取色/定位/让位锚点，body 子树 MutationObserver + 祖先属性观察捕捉外壳原位增删与搬移（不依赖 600ms 对账），80ms 过渡采样按目标计数、表面搬离自动停止；条面精简：缓存命中率/请求次数/轮数/耗时/首字收进 tooltip（0 命中也显示 0%），窄窗 .zu-main 横向滚动 + focusin 滚入可视区、切回默认复位 scrollLeft，不触发默认态收缩/渐隐；⚙ 面板宽度在药丸下跟随所属卡（不再跨分栏），主题 radio 按实例分组 name 防多面板互斥；数据重建先绑 __tip 再恢复焦点，aria-describedby/tooltip 不丢；modalOpen 豁免 zusage-panel 自有面板（修设置面板被误判宿主模态整条收起） → v143 药丸收口审查（review-fix-merge）：8px 双间距按宿主实测几何收敛——adjustPillBottom 沿所属 pane/dock 实测矩形补足让位并带 floor/不增长护栏，无法让位的绝对定位布局 visibility 安全隐藏（无每帧显隐抖动）；pillMarginTarget 落在 .chat-composer-input-surface，Highspeed 退出后默认卡重解析（composerCardOf 优先原生 data-testid 输入框）、宿主 margin 变更原值+优先级还原；悬停 tooltip 在 pill 下实时刷新隐藏明细并保留选区/滚动，焦点恢复区分 Escape 关闭与悬停接管；modalOpen 纳入 alertdialog；协调器候选补可见性过滤且已绑定输入框豁免 45% 阈值（上下分栏不再反复挂卸）；表面祖先观察改快照重建防泄漏 → v144 ⚙ radio 对齐修复：.zu-settings-langs/.zu-theme-options 的 label 显式声明 flex+align-items:center+gap:6px——原 label 继承 .panel label 的 flex-start 顶对齐（gap 14px），radio 圆钮相对文字中线偏上约 4.5px；新规则 (0,2,1) 特异性覆盖 (0,1,1) 基础规则，实测居中 delta=0 → v145 切回默认主题补还原 bar.style.visibility（pillUnsafe 安全隐藏是 pill 专属态，写入点仅 track 的 pill 分支；此前 pill 隐藏态下切回默认条永久不可见，十路评审 P1） → v146 精简模式（theme 第三档 compact）：条永久隐藏但保留 DOM（<style>/ariaLive 随条存活、heavy 保条对抗 React 清子树）；生成速度改挂工具行 .zu-tsb（重置卡左侧，挂载/位置兜回/签名幂等照重置卡同款），内容=zuBarSpeedView 桥两态或 tpsBand DB 回退、无有效样本不渲染（用户拍板）；tooltip=速度读数+状态条摘要（本轮/会话/工具/今日/子代理，逐格开关继续生效、子代理行点击开明细）+tpsBandLegend+「打开设置」按钮（镜像齿轮开启分支，面板精简下贴输入卡定位）；updateLive 10Hz 心跳原地跟随；非精简主题 syncTpsChip 门控摘除；诊断 mode=compact → v147 精简模式速率 chip 挪前导区（用户规格）：git chip 左侧——git 在时插其前、git 不在时占其锚位（cua-entry 后方/前导区末尾），两侧位置兜回收敛为 [锚][速率][git]（git 兜回容忍速率占相邻位防逐拍拉锯）；前导区发现失败回落尾随区（重置卡/额度组左侧） → v148 精简速率 tooltip「打开设置」按钮右对齐（用户规格）：footer 改 flex 布局，说明文本 tps-note-t 占据剩余宽度、按钮 margin-left:auto 推至最右，长文本换行不断布局 → v149 精简速率 tooltip 摘要行单位 tok→token（用户规格，与回答末尾统计行的 token 措辞对齐） → v150 修复精简模式 git chip 永不挂载（用户报告）：v147 的 git 兜回容忍条款（速率占锚位时不挪）误拦首次挂载——速率 chip 常驻锚位时 enhanceGitChip 每拍判"已就位"跳过插入；改为 chip 未连入 DOM 时无条件首挂（落速率后再由速率兜回收敛 [锚][速率][git]），容忍只用于已挂载的位置保持 → v151 工具状态词改版（用户规格）：Bash 动词「正在执行」→「工作中」，未知工具回退同改（正在执行 X→工作中 X）；工具计时分隔去中点（正在读取 · 4.3s→正在读取 4.3s 一并生效） → v152 工具动词 Read「正在读取」→「读取中」（用户规格） → v153 工具执行状态词定稿（用户规格）：Bash 与未知工具回退「工作中」→「执行中」（无名词回退英文 Working→Executing 对齐） → v154 工具动词全面改「X中」体例（用户规格）：写入中/编辑中/搜索中/获取网页中/更新待办中/读取待办中/运行技能中/读取上下文中/发送消息中/获取任务输出中/停止任务中/编写工作流中（Read 读取中、Bash 执行中、Agent 子代理运行中此前已改；英文标签不变） → v155 审查修复批（review-fix）：①compact 下 positionSubPanel 被隐藏条僵尸 .zu-sub 抢锚（零矩形把明细面板钉左上角）——chip 优先锚；②速率 tooltip 内容含秒表，悬停中 10Hz 整片重建吃掉「打开设置」/子代理行点击——显示中内容变化冻结只跟位置；③track compact 早退补两面板周期跟随；④自清选择器补 .zu-tsb、跨代采纳 chip 统一挂装（__zuWired 防重）修复热更后悬停/键盘失效；⑤closeSettings 焦点归还校验 offsetParent（compact 下不落隐藏 gear）；⑥enhanceGitChip 重复 var slotNode 清理。Web 同批：①③⑤（mousemove chips 归属校验只接本实例）+chip focus/blur 键盘可达对齐桌面 → v156 上下文按钮增强开关（issue #141）：⚙ 通用区新增「上下文按钮增强」checkbox（localStorage zusage3.ctxEnh，缺省开、仅显式 "0" 关），关闭走 enhanceCtxButton 关闭分支还原原生环/百分比且重置卡徽标继续维护（restore 顺带清徽标后立即重挂） → v157 修复精简→默认切换残留空壳细线（用户报告）：compact 期 render 短路会让空壳条面（热更占位/清子树后未填过）因签名相等一直存活、切回默认露出细线数十秒；①离开精简立即恢复 display（compactHid 区分初载 none，初载不提前露条保 pill 定位契约）；②离开精简强制条面重建一次（lastHtml 清空）；③compact 短路加 main.children.length 门——空壳先补一次完整渲染（条隐藏不可见）；④render 公共尾部补 syncTpsChip（短路/直通两路都经）→ v158 并流 fork/main cmdkW 线（PR #140，原线 v146 与主线 v146 精简模式撞号按合入顺序顺延）：宿主命令中心（⌘K 搜索弹框）加宽加高开关（⚙ 通用区，zusage3.cmdkW 缺省开）：条样式表规则 max-width:max(32rem,80vw)!important（原生上限=宿主 quickPickDialogClassName 的 max-w-lg=512px，弹框基础类自带 w-full 窄窗本就满宽，故小窗保持原样）与高度同规格（弹框根 max(90dvh,calc(100dvh-6rem)) 不低于原生上限，cmdk 列表 440px 硬顶放宽为 max(440px,calc(90dvh-15rem)) 小窗保底），<html> data-zusage-cmdk 属性门控（applyCmdkW，与 v136 projPath 同款），:has(>[data-slot=command][cmdk-root]) 只命中 cmdk 弹框——命令中心/任务搜索/快捷指令共用该样式常量一并放宽，设置页等普通 Dialog 不受影响 → v159 重启提醒开关（issue #139）：⚙ 插件更新区新增「更新后提醒重启」复选框（zu-restart-notice），经主桥 restart-notice 动作原子写运行时 config.json 的 restart_notice（缺省开、显式 false 才关、异常值不静默）；session-start hook 的 session_notice 读同一键，关闭后每个新会话不再注入 🔴 重启/安装提醒引用块（/install-overlay 命令行输出与自动安装失败、桥补装的故障提示不受控）——工作流模式多会话不再被逐会话植入提醒  → v160 Skill 运行期状态词显示「技能名·执行中」（用户规格，如「查阅·执行中」+计时）：turn-stats runningTool 透出截 160 字的 inputText，overlay 端 zuSkillName 提取 JSON name 字段（正则兜底、控制字符拒绝、超 24 字省略号截断），取不到回退「运行技能中」→ v161 状态条新增「项目累计」格：会话累计右侧渲染本项目（session.project_id）全部会话聚合（含子代理，口径同 session_usage；远端/不在本地库无字段不渲染），⚙ 状态条显示加「项目累计」开关（show.proj，默认开），精简摘要加同款行 → v162 状态词流光（用户规格）：速率 chip 纯状态词态（思考中…/工具动词/技能名·执行中）复刻宿主 .zcode-loading-label 同款流光——subtle→foreground→subtle 渐变 background-clip:text、1.4s 横向扫光、reduced-motion 停用；类名/关键帧自有命名（zu-shimmer/zu-loading-shimmer）不依赖宿主全局类；带 t/s 数值的估算/真实/DB 回退态不含 → v163 会话累计/项目累计 tooltip 增按模型明细行（top 8 按总量降序 + 「另有 N 个模型」，轻量行无 models 字段不显示）→ v164 tooltip 收口（用户规格）：模型明细全量展示去「另有」折叠、总和行置顶、键列自适应宽不换行、时间范围行 sticky 吸底（rt-pin，五个 tooltip 统一）→ v165 模型明细表格化对齐（rt-models display:table，整块共享最宽键列，token/次数列纵向对齐）→ v166 会话累计/项目累计时间范围精确到秒（fmtStartS，用户规格；其余三格保持到分）→ v167 模型行去 rt-atom（Chromium 表格内在宽度在 inline-block 边界断行致数值折行，真实浏览器实测）+ 带 rt-models 的 tooltip 宽度帽放宽 860px（zu-tip-wide，取最宽一行）→ v168 格面计数改 fmt 万/亿口径（用户规格：≥1万 N.NN万、≥1亿 N.NN亿；本轮次/会话轮次/项目会话次/工具总数四处，tooltip 与精简摘要保持原值）→ v169 同容器双条去重（Windows 用户报告：最小化/还原窗口来回切出现两根状态条）——宿主窗口状态切换可能短暂保留旧视图副本/重建编辑框，协调器瞬态出现两实例两根条落进同一张卡；heavy 对账每拍扫描：同卡可见 .zusage-root >1 或两根 body 兜底条矩形重叠过半时，data-zusage-slot 大者 hideBar 让位（对手消失经 track 自动复显；拆分窗格各卡各条不受影响） → v170 tooltip 计数同口径（用户规格）：各 tooltip 标题/规模/工具/请求行与模型行、精简摘要行的次数/轮数/会话数全部走 fmt；子代理明细面板保持原值 → v171 修 issue #147（社区 @Mc-GrowlR 报告并给出方案，Windows 10 + ZCode 3.17.1）：划词 side chat 面板容器无 data-pane-id，被协调器 auto 兜底键当作独立 pane，同窗出现第二条状态条（Radix presence 常驻挂载，面板收起后幽灵 composer 仍持续命中扫描）；窗口存在真实 pane 键时丢弃 auto 键——老宿主全部候选均为 auto（单键）单实例行为不变、shadow/iframe 空文档兜底不受影响 → v172 待重启/待更新改由 ⚙ 齿轮红点提醒（restartNotice 开关改为控制红点；会话内文字重启提醒取消，plugin-updater 推送 markerAt 作红点代际，点进「插件更新」分区记为已查看）+ ⚙ 更新页「重启 ZCode」按钮（二次确认，主进程 relaunch 动作）+ 移除自动安装开关（hook 未注入一律自动装，auto_enabled/INSTALL_MESSAGE 会话出口删除）   // 悬停 ⚙ 面板可见；版本号随代际递增 → v173 强制 K/M/B 单位开关 → v174 辅助对话独立状态条（宿主 tabId 成键 + 实例配额 4+1、桥 scope 精确绑定、确定性统计行按会话根归属）→ v175 辅助对话回答末尾富文本与主分栏同规则（显式本地 scope + isCurrentTurn 活跃轮限定 + --current 的 promptTs 守卫；修宿主 modelDurationMs 只累计高速供应商致占位行永久「生成时长缺失」；富文本收集后统一发起、同 SID 只追活跃轮且 epoch 粘滞防多轮搅动） → v177 review 修复批（10-agent 全量 review 闭环）：双条去重抑制不再被 track 每帧复显打穿（v169 Windows 双条场景实际失效的根因，复显前查 dupSuppress、heavy 每拍重评估解除）；精简下速率 chip 被摘除后子代理明细面板保持原位（不再回落隐藏条内全零 .zu-sub 抢锚钉视口左上角，web v103 同款）；精简短路块恢复 syncTpsChip 数据点 reapply（2976478 挪公共尾部后短路 return 到不了、与 git chip 不对称）；relaunch 无回执 4s 提示主进程可能是旧版需手动完全退出（旧 pollPluginRequests 白名单外动作静默丢弃）；待办红点指纹改分量级比较（更新装完后 latestVersion 分量退出不再误复亮）且 ack 幂等早退前先收敛本窗口红点；cnNum 切换补富文本 unitEpoch 在途竞态守卫（同 forceKmb）；detRootEl 落在宿主 data-session-id 写入窗口期时 heavy 按拍补算自愈；精简说明文案对齐 v147 挂载位（前导区 Git 左侧）→ v179 自动压缩阈值注入：⚙ 开关+模式+数值+状态行（enginePatch 随插件状态回推，__zusagePluginState 种子+拷贝行同 v172 纪律），主进程 engine-patch.cjs 按引擎 SHA256 白名单对 glm/zcode.cjs 打阈值改道补丁（锚点唯一性+use strict 指令位校验 fail-closed，hook 缺席/返回空双兜回 fail-open），阈值 autocompact.json 由引擎 hook 每轮决策 mtime 缓存读取——数值热生效、补丁冷生效（已运行 agent 子进程下个 spawn 起用）；ctx 按钮 hover 面板加「自动压缩 ~X%」行（acInfoText 按标称窗口口径，21K 预留近似还原）；关闭开关=按当前内容反向还原引擎字节；阈值任何形式钳 1% effective 地板防连环压缩→rapid-refill 熔断→ v180 重启按钮错位守卫（issue #158）：主进程 pushPluginState 携带 relaunchSupported 能力标记（与 relaunch 分支同文件、天然同步），浮层缺标记时隐藏按钮并显示「完全退出后重开」指引（syncUpdate + 点击守卫双处）；主进程 pollPluginRequests 白名单外动作兜底回执 unknown action，重启回执明确区分「主进程是旧版本」 → v183 子代理行内实时速率 chip（v4 Agent 行 testid 后缀即 childSessionId、与 v97 槽位键同源：运行期读槽位估算、完成后读泵快照 sub.list 真实加权速率；TPS 十档色；悬停 tooltip） → v184 ⚙ 新增「子代理行内速率」开关（state.show.subRate，zusage3.show 整包持久、默认开；只门控行内展示） → v185 实机修复批+review 修复批：后台子代理在宿主注册表无现成 store（运行期估算自 v97 起从未真正工作）→桥 v2 acquire 访问器按已验证 scope 解析子会话租约（仅 sess_subagent_ 前缀+本地）；tooltip 构建器改收数据包（buildTip(el.__zuT) 约定）；截断改从尾部取（保最新派发 8 个）；SUBRATE_DIAG 提模块级；诊断按 handle 判绑定；实例 dispose 摘行内 chip→ v186 本会话平均 token/s（PR #157 收编）：状态栏完成态主数字改会话加权平均（zusage avg_tps：Σ有效输出÷Σ生成窗口，main_turn 段、不含子代理），「均」前缀+按均值分档，最近一段/最近一轮退 tooltip；速率行/CLI 加「会话均」，精简 chip 同步；updateLive 会话归属取本 pane 行（lastView.session），缺席回退原行为→ v187 补回 v181 工具组状态词（PR #161 合并时 turn-stats runningGroupOf 块与 overlay 消费分支遗漏入库，仅存于运行目录热修副本）：turn-stats 复刻宿主 exploreGroup/executeGroup 合成规则（≥2 连续同类行成组、半截 JSON defer 透明、startedAt 锚定组首行），运行行落组尾时状态词显「查阅·执行中/终端·执行中」替代逐工具动词，计时从组头起算 → v188 自动压缩阈值注入按验收反馈简化：开关默认开（主进程 auto_compact_patch 缺省开、显式 false 关）；UI 只留百分比数值（留空=跟随引擎默认），模式下拉移除（引擎层 enabled:false/tokens/buffer 协议保留兼容，配置文件手写仍生效）；标题改「自动压缩上下文阈值注入/压缩上下文阈值数值」；状态行补 14px 水平内边距与 label 文本对齐 → v189 hover 面板阈值信息行移到「压缩上下文」按钮上方并追加下划线「调整」链接：点击复用 gear.click 完整路径打开 ⚙、切「通用」分区、scrollIntoView(nearest) 定位阈值数值行并高亮 3 秒（.zu-ac-flash，计时器实例级归属 dispose 清理）；info 结构改首文本节点+常驻链接（整行 textContent 覆盖会抹掉链接） → v190 三处验收微调：hover 阈值行 text-align:left（与卡内其它行对齐）；高亮改琥珀左条+淡底（--color-brand 在宿主主题是白色系，outline 描边观感像输入框焦点）；⚙ 注入开关关闭或主进程未加载时数值行整行 hidden → v191 hover 阈值行 token 数改走 fmt()：万/亿/K·M·B 与状态条、tooltip 同一转换链（跟随中文单位开关与强制 KMB 开关，中文至多两位小数去尾零） → v192 hover 阈值行布局：去掉自加 6px 下边距（间距交给宿主 space-y-3 的 12px 节奏，与「平均缓存命中率」行 pt-3 距分割线一致）；行改 flex 两端对齐，「调整」链接居右 → v193 修 v192 贴按钮：宿主 space-y-3 是 Tailwind v4 :where() 零权重 margin-bottom，行上自写 margin 会按类名权重压掉它（v190 的 6px 显挤、v192 的 margin:0 贴紧同因）——删掉 margin 声明整段回落容器原生 12px 节奏 → v194 阈值百分比改总窗口口径+数值行 30-99 校验：设置 91=原生按钮走到 91% 触发、hover 显示 91%（旧口径按扣除 21K 输出预留后的有效窗口算，设置值与显示差约 2 个点被判为割裂）；引擎 hook 以 eff+21K 近似还原标称窗口并钳在 eff 内，writeConfig 白名单收紧 30-99，已打补丁引擎下次启动按 PROLOGUE_V1 原位换装新 hook；⚙ 数值超范围实时提示并拒绝提交 → v195 hover 卡新增新手说明行：阈值行下方小字（.zu-ac-hint，随行同生命周期）解释口径与后果——「按窗口总量计算（与顶部百分比同口径）；走到该比例时客户端会自动压缩较早的对话内容以腾出空间」；margin-top 收紧 space-y 间距（space-y v4 只写 margin-bottom，top 无冲突） → v196 「调整」失灵诊断面包屑（下版移除）：openAcThresholdSettings 在 enter/after-gear/+150ms/row 各点写 __zusageDiag.acOpen（面板态、gear 可见性、条 display、分区、代际），closeSettings 写 acClose 调用者栈；v197 实证 acOpen 为空=点击未到达处理函数 → v198 修「调整」失灵：链接监听改 pointerdown（宿主疑似 mousedown 即关 hover 卡、click 到来前链接已被摘）+ 行级 click 兜底 + 捕获期点击写 localStorage 并在说明行回显（命中标绿/落空标红，诊断下版移除） → v199 清理 v196-v198 诊断：acOpen/acClose/acClick 面包屑、localStorage 回显、命中/落空着色全摘；保留 v198 修复本体（pointerdown 主监听 + 行级 click 委托兜底），实机验收=电脑操作点击「调整」面板弹出且阈值行琥珀高亮 → v200 上下文按钮增强显示层优先镜像原生 aria-label 已用/总量（宿主 taskUsage，压缩后立即回落；issue #172 曾停在 DB 最近完成请求旧值 16.4%），解析不出回退 lastBand DB 口径（ctxOv/nativeCtxVal 优先级只作用兜底），exc 过程态档位仍优先，还原路径共用同一解析器（英文 UI restore 顺带修对） → v201 合流：v200 撞号顺延（v200 已被并行线 issue #174 压缩按钮开关占用，8e6e1c0 先合入） → v202 预估费用行：四格 tooltip（本轮/会话/项目/今日）按 models.dev 官方牌价估算费用（token_pricing.py 内置表 326 条 + serve 内 12h 同步 models.dev 与 er-api 汇率，pricing-cache.json 落盘），快照加 cost_usd（USD）与 fx，展示层 ×汇率显 ¥（无汇率降级 $），会话/项目模型明细行尾加各模型费用，「价格来源 models.dev」脚注可点（openExternal），费用行尾空心问号图标悬停弹说明小气泡（价格来源/计算公式/汇率来源三行，fxTip 独立浮层 + mouseover/out 委托 + 180ms 悬停桥，主 tip 收起/重建时同步收），汇率源主源失败兜底 exchangerate.fun（自定义 fx.url 不启用），⚙ 通用区开关默认开，本库口径：裸输入=input−cache_read−cache_creation 全价、缓存分价、output 已含思考不另计 → v203 红点仅承载待重启（发现新版未安装、更新成功且已热重载均不亮；分量级已读比较保留以兼容旧 seen 串）+ ⚙ 带待重启红点点击直接落「插件更新」分区（激活即 ack）+ 设置页新增「已更新成功，点击重启 ZCode 即可生效」提示条（旧主进程降级回原文字指引），分区切换提取 activateSettingsSec 单一出口 → v209 额度 chip .zu-quota 与重置卡徽标 .zu-ctxrst 左右内边距 6px→3px + 模型选择触发按钮（chat-model-select-trigger）左内边距减半：文本态 8→4px、图标态 6→3px（!important 压宿主 group 变体）（用户规格 2026-11-02） → v210 时间范围行全部精确到秒（v166 会话/项目累计先行的 fmtStartS 扩展到本轮/今日合计与速率 tooltip 最近一段；fmtStart 仅剩「最后活动」行）（用户规格 2026-11-02） → v211 本轮 tooltip「单次耗时/首字延迟」改「平均耗时/平均延迟」（zusage 快照 last_turn 新增 avg_duration_ms/avg_ttft_ms，对 model_usage 该轮已完成 main_turn 行 >0 样本求均值；turn_usage.ttft_ms 聚合列实测口径不明不可依赖，旧快照缺字段整行不渲染）+ 本轮格面移除时长/首字两段（耗时只在 tooltip），精简摘要「本轮」行时长随同改平均（用户规格 2026-11-02） → v212 Git chip 分隔符 .zu-git-sep 间距收紧：字面「 · 」改纯点+左右 2px 内边距（多仓段与 ?N 未跟踪段两处同源；用户规格 2026-11-02） → v213 状态条格序调整：今日合计提前到会话累计之后（速度→本轮→会话→今日→项目→工具→子代理→⚙），速率 tooltip「状态条摘要」行序随同对齐（用户规格 2026-11-02） → v214 项目累计统计卡改版：tooltip 重构为「标题+统计范围（全部请求·含子代理）、总用量/请求次数/预估费用三 KPI（费用旁统一说明问号）、输入(命中率)/输出(含思考)/缓存写入明细、会话·轮·工具·重试规模行、模型四列表格（默认 6 项可展开全部，排序对副本）、时间范围（em dash）」，作用域 .zu-project-tip + :has 样式（不动共享 .tip/.rt-* 规则），展开态实例级归属键（sid:started）局部更新不重建整卡，触发项 zu-pj-item 标记，卡片内 Escape 关闭并归还焦点，focusout 进卡片不误关，positionTip 钳底边，费用全链复用 v202（0 有效/缺失 —/开关关整格收） → v215 六统计卡统计卡化：本轮/会话累计/今日合计/子代理四格 tooltip 统一 zu-stat-tip 视觉体系（速度统计卡公共构造：scope 标签+双读数 hero 主读数档位色、两行五列网格窄窗重排、速度卡宽帽 760px :has 作用域；明细面板内模型行问号图标弹费用说明气泡，复用 fxTip 单例同款委托）（用户规格 2026-11-02） → v215.1 速度卡去费用行与模型明细（用户规格：速度 tooltip 只留读数与时间范围，费用唯一承接处=各卡明细面板与 fxTip 气泡） → v217 子代理统一浮层：.zu-sub-pop 双栏单组件替代「悬停五段卡 tooltip+点击独立明细面板」两套旧 UI（preview/pinned 状态机：悬停预览、首次点击固定、面板内操作转固定、Escape/关闭/外点统一收且焦点归还+500ms 悬停抑制；选中按 sid 维护、运行中未入库槽位进导航、签名幂等重建保滚动、会话切换即关、入口断连即关；任务页 _sub_item 逐任务模型用量表/预估费用/平均速率档色行/最后活动全格式时间，zusage sub.list 单项同步扩展；精简入口 chip.__zuOpenSub 归一指向同一浮层）（实机验收 2026-11-03） → v218 速度卡三修（实机反馈）：悬停冻结 updateLive tipFor 判定改 contains（旧恒 false 致悬停中 tooltip 不冻结）；右格「最近一段」改读 lastView.last.tps（zuBarSpeedView 无 latest 字段恒缺）；图例 ≥2000 Ultra 改渐变圆点并禁 ✦ 伪元素（星点破形） → v219 ⚙「状态条样式」（默认/药丸/精简单选+精简说明行）从「通用」分区移入「状态条显示」分区卡首，纯分区归属调整，控件与持久化行为不变 → v222 速度卡 tooltip 补「时间范围」行（用户规格，参考四格 tooltip 同款式）：主数字为会话均/桥态取会话累计口径（started→last_at，与会话累计 tooltip 同源），「最近一段」回退态保持段范围；起点缺失整行不渲染（半程范围无意义）；三处 speedCardHTML 调用点（桥态 buildLiveTip/DB 回退/精简 chip）同批生效 → v223 ⚙ 面板关闭按钮命中区外扩（原并行线编号 v220，合入顺延；::after inset:-6px、hover 反馈同步，约 20×24px→32×36px）：按钮四周 head 空白点击原本无反应，用户实测「悬停 × 上点不动、不灵敏」；CDP 真实点击定责为命中区过小（事件链与面板几何均无缺陷），纯命中区修复，不改布局与视觉 → v224 速度卡悬停实时刷新二次修复（实机反馈）：v218 只改了 tipFor 判定，新 tip 串仍写到格内 .zu-live span，而 __tip 宿主与 drawTip 读取都在 .it 格元素上——条件每 tick 命中、重画的仍是整条渲染时的旧串，悬停中「当前读数」冻结在最后一次整条渲染的值（chip 已跳动、tooltip 停在「思考中…2秒」）；改写回格元素（liveEl.closest(".it")），悬停中每 tick 跟手重画，未悬停也保持新鲜 → v225（v224 并行线 PR #198 先合入，本线顺延）⚙ 自动压缩状态行区分「引擎被单独热更」（issue #191）：桌面 build 已登记而引擎 sha 脱钩时明示热更事实与漂移 sha 前 12 位（引擎补丁新增 drifted 字段，主进程传入 appVersion 按点分界前缀匹配登记表），替代误导性的"版本不在支持名单"；lastError 后缀此时与 sha 重复不再拼接；fail-closed 判定不变 → v226 ⚙ 两项（用户需求 2026-11-03；v226 已被并行线自动压缩状态行占用，顺延）：①六格显示开关（本轮/会话累计/项目累计/工具调用/今日合计/子代理）全部关闭时样式自动转精简（边缘触发只在「变得全关」那一拍切档，zusage3.autoCompact 记录来源主题 default|pill，重开任一格恢复、面板手动改档即解除；药丸来源同样触发）②默认样式新增「水平对齐」三选一（zusage3.barJust：均分 space-between 缺省不挂类/居左 flex-start/居右——居右不用字面 flex-end，LTR 下 start 侧溢出不可滚动也不计入 scrollWidth 会废掉收缩检测与 .zu-clip 渐隐，改首格 margin-left:auto 等效右聚拢、溢出方向与兜底不变；设置块仅默认档显示，applyBarTheme 随档显隐并同步条上 zu-just-* 类） → v227 预估费用说明气泡悬停保活（fxTip 是 body 级独立浮层、挂在主 tip 之外：指针从 ? 图标移入气泡被文档 mousemove「条外」分支按 left-bar 强制收主 tip、hideTip 同步收气泡，v202 起悬停说明气泡即灭；子代理浮层路径同被 preview-leave 倒计时收走面板。mousemove 处理器节流前新增分支：fxTip 显示中且目标在气泡内视同仍在 tooltip 上——保住主 tip 与气泡、取消越顶宽限与子代理面板延迟关闭，离开气泡回落原判定） → v228 速度 chip 完成态去「· 近X」尾缀（用户规格；编号顺延避让已合并的 v226(PR #200)与 v227(PR #202 fx-tip-keepalive)）：条面格与精简 chip 同批去掉 dbTps 尾缀，主数字只显会话均（或最近一段）；「最近一段」读数保留在 tooltip 右格不受影响 → v230 压缩轮不再显示「本轮统计不可用」（编号顺延：原 v238 号，v229 已由并行合入的 PR #207 占用、v231 起由并行未合线自占）：上下文压缩（手动/自动同链）是 query_source='compact' 的辅助轮（DB 有完整数字且已计入今日/会话累计，但消息流无正文、header 零输出），旧逻辑按 v74 零输出明示规则误插误导占位——实测压缩轮投影=turnHeader+timelineMarker(marker.type='compact') 而 header.executionKind 恒 'agent'（ek 探针证伪初版假设），turn-stats get() 以 isCompact 识别，overlay 对压缩完成轮不新插/撤下已插行（宿主「上下文已压缩」提示已承载语义）；kinds/tmr 为 det 诊断字段；v74 真实零输出轮行为不变 → v231 统计卡标题拼接名称与垂直居中（用户规格三轮迭代一并入库；编号顺延避让并行已合入的 v229(PR #207, issue #205)——v228 后 overlay 台账实际未占用，按共享代际台账撞号声明让号）：①项目累计卡拼项目名——zusage _project_usage 附 name=启动目录末段（正反斜杠归一，缺目录/旧快照判空不渲染），.zu-pj-pname 字号颜色同规模行 .zu-pj-scale；②会话累计卡拼会话名——快照行 title 三处本就产出，纯渲染端：statHead 加可选第三参仅会话累计卡传、/\s+/g 压空白、缺 title 判空不渲染，.zu-st-name 360px 省略号；③名称与标题垂直居中——标题容器带名称时切 .zu-tt-name（display:flex;align-items:center），行内 baseline/bottom 对齐会被 18px 大字 descent 拖得视觉偏低（实机指认），flex 子项自动块化、省略号仍成立 → v232 速度 tooltip「最近 20 段」柱状图：zusage 快照 session 行新增 speed_segs=最近 ≤20 条已完成 main_turn 有效速度段（_row_gen_ms 窗口与 avg_tps 同款口径、辅助源/子代理/碎段不计，v 保留原始浮点供档位与柱高按原始值判断；speedCardHTML 带 segs 时切「左读数卡+右图表」布局——左卡=当前读数/档位胶囊/加权平均说明，「最近一段」右格由最新柱承载，无 segs 的旧快照/远端旧版保持 v215 原布局），柱顶读数恒一位小数与柱同轴心、最新段加粗，Y 轴 0 起整洁刻度并按「信息卡横向覆盖最右约 1/3 柱」约束迭代刻度保证最高柱读数不被压住，X 轴=分段真实完成时间本地时区 MM-DD HH:mm 稀疏显示、首末恒留，最新段描边高亮+「最新」徽标，柱体颜色沿用 TPS_BANDS 档位类（ultra 渐变深浅主题显式 border-box 覆盖防 clip:text 裁没），段值 ≥1000 t/s（读数 6 字符）或窄窗口（plot min-width+横滚）保读数永不重叠；柱级悬停/键盘焦点弹信息卡——tip 本体委托 + 实例闭包存悬停段下标经 speedTipRebuild 编进串（签名幂等重建不丢状态、离开回落最新段、会话切换重置），render 接管对速度格补 drawTip 使打开中随快照跟手（焦点/选区在 tip 内时跳过），图表横滚位置跨重建保留；精简 chip tooltip 不带图表 → v233 速度卡三删+读数自适应（用户规格）：①删「统计会话全部已完成请求：工具等待不计，不含子代理。」口径行（DB 回退与精简摘要两处，Σ输出÷Σ生成耗时等其余口径保留）；②删柱状图「最新」徽标（最新段描边与加粗读数保留，plot 高 200→184）；③删「每段完成后更新；不足 20 段时显示实际数量。」脚注（live/回退两处）；④左卡「当前读数」估宽分级自适应（超长状态词降字号+允许换行，不再被 156px 左卡裁切；分级实现见同批改动） → v234 柱状图 20 段→14 段、释放空间给左卡（用户规格）：zusage 新常量 _SPEED_SEGS_MAX=14（与 last.tps 回查的 _TPS_LOOKBACK 分离，扫描窗 42 行凑 14 条有效段）+ speedSegsOf 渲染端截 14 + 两处口径行「最近 20 段：…」改 14；左卡 156→300px（内宽 278），主数字删 +12px 覆盖回基础 ui+22 大字，估宽分级阈值重算 ≤7.5/≤11.5、fit2 +6→+10px；plot min-width 600→420（pitch≥30）、wide 780→560、xEvery 估算基数 620→460/最小标签距 44→30（14 柱满宽全显时间标签） → v235 速度 tooltip 多状态结构化重构（用户设计图规格）：zuBarSpeedView 追加结构化字段 kind/statusText/nameText/nameFull/elapsedText/speedValue/speedIsEstimated/speedSource/activeCount/noteText（八类 tool/toolgroup/skill/subagent/thinking/estimate/avg/real，text/cls/phase/band/latest 逐字保留、状态判断不解析文案）；speedCardHTML 新增 o.status 分层左卡模板（zu-sl-status 状态标题+子代理 ×N 徽标 / zu-sl-name 名称两行省略+title 全名 / zu-sl-main 主数值或计时 / zu-sl-unit / zu-sl-note 辅助），数值型走档位色、工具/Skill/思考/子代理保持 dim，o.main 拼装路径为精简 chip 等旧调用方保留；子代理估速前缀 ≈、无效估速显「估算中…」不补 0；buildLiveTip/fallback 传结构化状态，scope 标签按真实状态映射（工具执行中/工具组执行中/Skill 执行中/子代理运行中/思考中/生成中估算/会话平均/本轮真实速度），思考态左卡内嵌脑动效图标；柱状图 14→17 段（_SPEED_SEGS_MAX=17、渲染端截 17、口径行改 17），plot min-width 420→500/wide 560→680/xEvery 基数 460→500/最小标签距 30→29 配平左卡 300→250px → v236 速度 tooltip 三修（用户实机反馈）：①信息卡改为悬停/键盘聚焦柱体时才渲染（默认不再常驻最新段上方，cur 高亮随之仅悬停态、latest 描边保留）；②X 轴时间标签最小距 29→44（17 柱 pitch≈29 必隔列、间距 ×2，修复标签拥挤）；③非 wide 图表删 plot min-width（随容器压缩+稀疏标签兜底），任何窗口宽度不出横向滚动条（wide ≥1000 t/s 保留横滚），速度卡宽帽 860→1040 → v237 修时间标签裁半（用户实机截图）：v236 的 border-box 配平让 X 轴行内容区只剩 20px、两行时间（25px）被 wrap 的 overflow-y:hidden 裁掉半行——X 行 24→29px（4 padding+25 两行）、plot 高 184→189，列配平随之 160+29 → v239 速度 tooltip 100% 复刻设计图（用户拍板以设计图为准，撤销 v233 删口径/v236 悬停才显卡）：信息卡恒在（默认最新段带「（最新）」+虚线引线连柱，悬停切段）、左卡状态图标+「当前读数」标签+档位色状态标题、颜色对照单行横排、统计口径左标题右分段+时间范围同卡、带图表时不渲染脚注 → v240 柱状图 17→10 段（zusage _SPEED_SEGS_MAX=10、渲染端截 10、口径文案同改）、柱宽 max-width 22→15px（-30%）、信息卡恢复仅悬停/聚焦才显示（撤销 v239 常驻）、左卡下半区加「峰值/最低/最新」概览填空、速度卡宽帽 1040→860、plot min-width 500→340 → v241 速度 tooltip 按设计图复刻：柱状图取当前会话最近 10 次（可跨天）、左卡标题行/主读数/说明行文案按设计图对齐（工具组「查阅」、Skill「执行中」、说明行统一「X · 正在执行」）、前缀「估/均」小号灰字、主体区垂直居中填空 → v242 速度 tooltip review 修复批（十 subagent 审查）：focusout/mouseout relatedTarget 守卫修 Tab 跨柱焦点断裂与双重建闪烁、render 接管 pill 主题补焦点守卫、wide 横滚复活（plot 420）、spanFrom 收严最坏一半 + CARD_H 36（实高 35.6 校准）、real 去档位胶囊、skill 标题统一无空格「·执行中」、工具组 statusText 回归完整短语、liveScopeMap real/estimate 用词对齐、「当前读数」标签与有效数值同门（修 subagent 数值误杀回归）、左卡 border-box 250/双规则合并/padding 12、标题档位色与单行省略、浅色 ultra 图例圆点 clip 修正、hero :has 单列、柱 role=img、17 段/常驻卡/帽 1040 等过期注释清理、测试补八态直调/概览三格/前缀/（最新）角标/图例行/几何不重叠断言 → v243 更新日志「发布页」链接 GitCode 渠道改指 /releases 列表页（tag 深链页对本项目 API 创建的 Release 一律「找不到或无权限」，GitCode 平台路由 bug 2026-11-04 实测；GitHub 渠道保持精确 tag 深链；镜像/未核实回退路径同规） → v244 重启按钮反馈与延迟（用户报告「点击没反应、等很久才退出」——大头是宿主 app.quit 优雅退出链要关窗并逐个终止会话/扩展子进程，可达数十秒，插件无法绕过）：确认发送即「正在重启…」+禁用+预期文案替代「发出即恢复」伪装无反应，4s 无回执/失败/90s 仍存活三路还原（ok 后挂 90s 兜底防 quit 被会话/扩展阻止永久卡死；4s 超时已还原则不再挂）；syncUpdate 重绘保持禁用与提示；主进程 relaunch 固定 300ms 延迟改回执送达后 30ms 退出（800ms 渲染端无响应硬兜底）；v245（同批提交）quit 前 hide 全部窗口——退出屏障期窗口不再可见干等，主进程 15s unhide 哨兵在 quit 未发生时恢复可见 → v246 用户手改批：速度图未悬停（hoverIdx<0）不渲染信息卡、span 只按 capOut 留柱顶读数净空，刻度基数补 6/7.5 防跳档空旷；X 轴同日去重（仅首枚显示标签柱与跨日首柱渲染日期行，其余同日只显 HH:mm）；本轮/今日合计首格改「总用量」、今日缓存命中率并入 grid3 输入列副行、本轮平均耗时/延迟/总耗时行改 --sub 弱化段、会话累计 scale 行分隔符改前缀式并删末项请求数、工具表 <50ms 显「<0.1s」弱化、子代理浮层 KPI 副行改命中率/含思考/缓存写入+平均速率并入 KPI、项目卡范围+scope 合并单胶囊+隐藏「按用量排序」+子代理浮层模型表去底色改行线、本轮输出速度单位 tok/s→t/s、图例 ultra 点隐藏与 inline 间距收紧、tbody scrollbar-gutter:stable → v247 悬浮窗口激活方式（issue 用户反馈：滑过误触遮挡）：⚙ 通用新增「点击激活悬浮窗口」开关（zusage3.tipClick 缺省关=停留 1 秒、仅显式 "1" 开=点击）；统计卡/子代理浮层 closed→open 改由独立 1000ms 定时器承接（排程置于 150ms 节流之前防快速滑入静止后永不触发、按命中元素 key 去重续期、到点按当前坐标 elementFromPoint 重命中抗 render 1.5s 重建 + :hover 最深元素复核），已开 tip 切相邻格保持即时，键盘 focusin 即时打开不变，取消统一落 hideTip/各 return 分支，定时器随 dispose 清理；点击模式 bar.click 接管 .it 并用 focusTipAt 避开 focusin→click 首击抵消（复用移出条面/Escape 关闭链，不另起 pin），fxTip/速度信息卡/工具栏 chip 与宿主原生 hover-card 不在本次范围→ v248 预估费用说明气泡「当前模型」随卡携带模型上下文（上一会话已完成、已部署未提交，与已合入的 v249（PR #224）并行开发，随本批补录入库）：四个统计卡与子代理浮层汇总的 KPI 费用问号随卡携带模型上下文（fxqIcon：data-model/data-rates=按用量最多模型+data-mcount+data-mscope），单模型显该模型四价、多模型沿项目卡口径显「计价范围」、无模型明细不显模型行，default 借 last 分支删除 → v249 用户裁定简化：「点击激活悬浮窗口」关闭（缺省）不再做停留 1 秒，恢复即时悬停原语义（v247 的 1000ms 定时器链 HOVER_OPEN_DELAY_MS/hoverSchedule/hoverCheck/hoverCancel 整体移除，mousemove 恢复 v246 逐行为）；开关开启仍为点击激活（bar.click 接管 .it + focusTipAt 防首击抵消、子代理 preview 关闭改 pinned 打开），设置项/文档口径同步为「悬停立即显示 ↔ 点击才打开」两态 → v250 速度柱状图按轮聚合+悬停卡全格式时间与轮明细+柱间距收紧（用户三项规格；编号顺延避让已合入的 v249「点击激活简化」PR #224）：zusage _speed_segments 改按 turn_id 合并一次提问的全部请求（v=Σ有效输出÷Σ生成窗口、逐问同口径），随段携带 m/i/o/n/c 供悬停信息卡渲染 模型/Token 用量（含输入·输出拆分）/请求次数/预估费用（数字格式化经 o.fmtTok/fmtCnt/fmtMoney 回调，费用随 state.cost 门控，旧快照缺字段按行省略，CARD_H 按实际明细行数校准）；悬停卡时间改全格式 yyyy-MM-dd HH:mm:ss；X 轴每个显示标签恒带月日两行（同日去重废止）；柱宽 calc(20%+12px) 使柱白任意宽度恒精确收紧 20%；段→轮措辞（最近 N 轮/第 N 轮） → v251 套餐额度显示口径开关（⚙ 套餐额度分区「显示剩余额度」，zusage3.quotaRemain 缺省关=已用%，纯渲染偏好不进 config.json）：开启后 chip 面分段数字与 aria、tooltip 窗口行/Key 总额度行/其他源摘要行改按剩余%（100−已用 同一窗口池补数，quotaRemainPct 钳 [0,100]）打头，绝对值窗口行内 已用/剩余 明细互换顺序；档位色恒按已用原始值判定（quota.md 契约）不随口径反转；余额/Key 剩余额度单段与团队/未配置/错误形态不受影响 → v252 模型拉取同步提供商侧配置（issue #236）：零兄弟供应商首拉写实最小骨架+有据元数据（contextWindow/inputFormat/档位/输出上限），档位按强度梯排序（宿主默认档=values 末项），Copilot capabilities 别名，api.json 档位目录按需后台补缺（大体量不阻塞，缓存后下次拉取生效），套餐源接目录补缺；弹窗行「未获取配置」中性提示+脚注披露只增不覆盖；档位索引落运行目录缓存（24h stale-while-revalidate 跨重启复用），目录后台补拉时行内「档位补拉中…」状态+脚注说明 → v253 本轮/今日合计 tooltip 模型明细改项目卡式四列表格（zu-pj-mhead+statTable，费用列随 state.cost 门控；本轮 rt-models 行式退役，精简摘要保留）+ 本轮 tooltip 删「速度＝Σ…未参与测速」口径行（unrated_output 字段照旧生产） → v254 生成速度 Tooltip 全面重构（范围/时间双 Tab 共 20 组合 + 按时间/会话/项目维度：zusage 新增真实库有界轮表 speed_history（短键+索引表+2s 缓存，单一 Σ有效输出÷Σ生成窗口口径，旧 speed_segs 契约不动），渲染端纯函数聚合；16 根细柱定宽居中、十档 TPS_BANDS 同源、删除均值虚线/统计口径大段/底部时间行/图表预览；右上角日历时间胶囊（title 全格式）、左卡历史均值与生成中估算分离、柱 hover 五字段自定义卡（时间区间/档位速度/多模型/Token 总量含输入输出/预估费用缺失态）、单行十档图例、空桶显空柱不显 0、远端身份下「全部」清晰降级、旧快照/精简 chip 回退原布局；Tab/dim/柱 hover 全走 tip 本体既有事件委托与签名幂等重建，不新增 IPC/定时器/全局监听） → v255 真实宿主验收三修（X 轴短时分标签+30px 裁切杜绝长时间戳重叠、左卡实时状态降为独立 note 且标题中性化「当前筛选 · 历史统计」避免工具执行中配历史均值语义错位、V2 实时状态变量更名 spdLiveStatus 与 buildLiveTip 旧局部同名隔离） → v256 修复「速度 Tooltip 有时新、有时旧」（用户实机报告）：根因=统一轮表只在 serve 常驻链产出，主进程常驻进程空闲回收/重启/降级时回退 zusage.py json 一次性帧缺 speed_history，spdRebuildOr 返回 null 整卡回退旧版；①zusage snapshot 增显式 include_speed_history 门控，serve 与桌面 json 都产出轮表（远端子进程 ZUSAGE_REMOTE_CHILD=1 排除，CLI/MCP/远端 stdout 契约不变）；②overlay __zusageUpdate 粘性保留最近一份有界轮表，缺字段帧不再闪回旧卡（空轮表不粘性）；③精简模式 tpsChipTipHTML 与 tpsTip 浮层补齐 V2 接线（双 Tab/维度/柱 hover 全走浮层本体委托、状态落 chip 数据包、V2 卡放行签名重建），V2 宽帽规则补 .zusage-tps-tip 宿主；冷文件 inject-main 未改，热重载即生效 → v257 追堵「首帧缺轮表」（用户 11:21 再现旧卡，渲染端 diag 实证已 v256）：v256 粘性只在代际内有效，热重载/重启后的新代际粘性为空，而 `_speed_history_safe` 在完成轮瞬间的 WAL 写窗口偶发抛错返回 None——首帧恰逢失败时无值可粘，仍回退旧卡。①safe 失败先短重试一次（50ms，新常驻进程首查撞写窗口时多半已放行；缓存 TTL 内不重扫），再失败跨 dbkey 回退最近一次成功轮表（`_SPEED_HISTORY_STALE_MS` 10 分钟上限，轮表是历史统计分钟级陈旧可接受，下一帧成功即覆盖）；②`__zusageUpdate` 帧级诊断 `FATAL.spdFrame`（has/sticky/turns，原地更新）——再出现象 diag 直接区分「数据链缺帧」与「粘性未建立」，不再靠截图反推 → v258 spdTip 取证诊断（用户 11:37 在 v257+首帧 has=1 下仍见旧卡，数据/代码/本地模拟三查均无异常，纯推理到头）：buildLiveTip/html(d)/tpsChipTipHTML 三条速度 tooltip 路径在 V2 成功时记 `FATAL.spdTip={t,src:"v2-live|v2-html|v2-chip",turns}`、回退时记 `{src:"fb-live|fb-html|fb-chip",turns,range,period,sid尾8}`，spdRebuildOr null 分支加 `FATAL.spdNull`（typeof FATAL 守卫不破坏 VM 切片）——diag 直接给出真实路径与当时轮表长度，定位后移除 → v259 宿主多视图顶部 48px [app-region:drag] 标题栏拖拽条穿透上层浮层（Electron 拖拽区按几何命中，覆盖层未显式 no-drag 不阻挡）：面板 top:8px 时头部 ✕ 落在条内，真实点击被窗口拖拽吞掉（新建任务页实报「设置关闭无效」，面板内导航点击正常与症状吻合）；.zusage-panel（设置+子代理浮层）/.tip（全部 tooltip 根）/.zu-mp-ov/.zu-compact-dlg 显式 -webkit-app-region:no-drag，把自身矩形从拖拽区减掉（宿主自家浮层与全屏屏障同款修法，app.asar 实证） → v260 静态桥缺席兜底（同内容仓库版记 v258，合入时按合入顺序归一；G2 跨版本免重打桥）：readFiberPaneScope 沿 React fiber 回溯 SessionPane 作用域（detOwnerOf/sidePaneKeyOf 的 tabId 同款兜底；限深 24、撞外层会话/分栏根止步、多候选歧义拒绝，校验与静态属性分支同规）；turn-stats.js 运行时合成 BRIDGE_TEMPLATE v2 同契约三访问器（Map.prototype 一次性探针捕获宿主注册表 + installRuntimeBridge 注入口） → v261 spdRender 取证补强（老会话完成态仍见旧卡而 spdTip 恒被 v2-live 每 tick 覆盖，hover 瞬间的整条渲染记录无法存活）：html(d) 整条渲染专记 `FATAL.spdRender={t,src:v2-html|fb-html,pane,sid尾8,turns,hasH,range,period,dim}`（独立字段不被覆盖），spdTip/spdRender 均带 pane 实例标识（多实例共享 diag 分不清写入者），spdRebuildOr null 分支补 spdNull 原因取证（typeof FATAL 守卫）；本版=运行目录 v260 合流超集基线 + 本诊断（v260 已含速度线全部修复与并行线 v259/v260 桥兜底） → v262 根治「空渲染污染共享数据」（spdRender 铁证定案：用户复现时刻整条渲染 hasH:false / spdNull hType:undefined，而前后帧 has=1——`render(d)` 首行无条件 `state.data = d`，实例 spawn 首渲染/桥空窗的 `render(state.data || {session:{},...})` 把空对象写进共享数据、抹掉统一轮表，窗口内 hover 即 fb-html 旧卡；切会话 tab 触发 pane 重建恰好高频制造该窗口，故「老会话旧卡、新会话正常」）：render 改条件写 `if (d && d.session && d.session.sid) state.data = d`——空对象渲染不再抹掉轮表，spawn 实例后续 updateLive 直接用上一真帧渲染（比旧行为更快出 V2）；真帧写入链（__zusageUpdate 外层）不变 → v263 根治「范围/时间 Tab 点击无效」（用户实报 P0）：①根因=生成中 updateLive 每 100ms 重编 V2 整卡（估算/计时走字让 tipSig 每 tick 变化），mousedown 命中的按钮在 mouseup 前被 innerHTML 替换、click 落到共同祖先 closest(".zu-sv-tab") 为 null；Tab 切换提前到 tip pointerdown 委托（重建窗口前同步生效，click 保留键盘/兜底，同值幂等共存），按下即进 600ms 交互冻结保下拉展开；②updateLive 冻结扩 mouseInBar（悬停保活不整卡重绘，数字冻结在进入时刻，typeof 守卫兼容 VM 切片）；③compact tpsTip 面：Tab 同款 pointerdown（tpsTabActivate）+ showTpsTip 撤销 v255 对 V2 卡的冻结放行（悬停中统一冻结，交互路径清 __zuTipSig 天然放行）；④视觉 12 项（视觉审查 Agent 实测截图清单）：Tab 选中态纯白改柔和强调 rgba(87,200,255,.14)+恒字重 600 防跳动、hover 补背景反馈，左卡删「Σ有效输出 ÷ Σ生成耗时」公式行、标题改弱化「历史统计 · 不含进行中请求」（.zu-sl-title 仅本卡作用域覆写，旧八态卡不动）、主数字 +22px，X 轴跨日首柱两行 MM/DD+HH:mm 且跨日柱稀疏化必显、xEvery 8⇒6 收紧标签间隙，图例 Ultra 补 ✦，维度下拉补 ▾ chevron，标题 +6px/时间胶囊 padding 4px 10px，间距归 8/12 节奏，柱组居中+删 --zu-sv-n 死配置 → v264 第二根因收口（实机点击仍关 tooltip 定案）：tip 内控件点击 ⇒ pointerdown 处理器同步重编 innerHTML ⇒ 被点按钮 detach ⇒ 焦点跌落 body ⇒ focusout(relatedTarget=null) 曾无条件 mouseInBar=false + hideTip(true,"focus-leave") 强制关 tooltip——切换生效了用户也看不见（旧版 click-only 同样中招，这是「Tab 点击无效」体感的第二半）。修复：mouseInBar（指针悬停在条面/tooltip 上）时降级 hideTip(false) 交总闸拦截，指针真正移开由 mousemove 判定；纯键盘 mouseInBar 已 false 维持原强制关。行为级回归：切片派发 focusout 断言悬停中 [false,"focus-leave"]/离场 [true,"focus-leave"] → v265 按下即建总闸（实机第 4 次点击实验定案的第三根因）：tooltip 常经 focusin 打开（点击 .it 聚焦），快速移动/合成指针下 mousemove 采样可能全部被 150ms 节流丢弃、mouseInBar 停留 false，随后一次快照推送的 render-orphan 接管失败即关掉正在交互的 tooltip，点击 Tab 落在消息区；pointerdown 委托开头 mouseInBar=true + cancelTipGrace，「指针按在 tip 内」先于一切判定生效，render-orphan 受总闸拦截，下一 mousemove 重新判定 → v266 render-orphan 悬停保留（第三根因彻底收口）：生成中宿主 phase 切换（思考↔工具↔正文）每次走 render 慢路径整条重建条面，条目结构变化时接管失败曾直接 hideTip(false,"render-orphan")——快速移动/合成指针下 mouseInBar 常 false（mousemove 采样被 150ms 节流丢弃，tooltip 经 focusin 打开），悬停中的 tooltip 随每次 phase 切换闪断、点击 Tab 落在消息区（实机第 4/5 次点击实验定案）。修复：mousemove 处理器开头（节流前）记 lastPt；接管失败时指针仍在 tip 覆盖矩形内则保留旧内容原地显示（不重画、不收），指针一动由 mousemove 重新判定；条外维持原收起 → v267 lastPt typeof 守卫（v266 裸引用打破 overlay-fx-tip-keepalive/overlay-tip-activation 的 mousemove 切片沙箱，与 v265 mouseInBar 同款教训：实例作用域新增变量一律 typeof 守卫或同步补切片夹具） → v268 粘性跨代际（用户实报「速度 tooltips 现在变成老版本了」定案）：v255 粘性是模块级变量，热重载/重启后新代际为 null，新代际首帧恰逢 serve 空闲回收/重启窗口（本地实测 serve pid 数分钟内 8576⇒11362 频繁重启；json 链本地实测 1268 轮/197 会话产出正常）即回退旧卡；修复 = 粘性写 window.__zusageSpdSticky（旧实例不清除、新实例继承，跨热重载/重启持久）+ 四处 V2 消费点（buildLiveTip v2h / html(d) spdRebuildOr / tpsTip 数据包）统一 lastSpeedHistory 兜底——帧缺轮表时以最近一份有界轮表顶上（历史统计分钟级陈旧可接受，v257 同取舍），下一帧成功即覆盖 → v269 lastSpeedHistory typeof 守卫（第三次同款教训：v268 三处裸引用打破 overlay-speed-chart 旧图切片沙箱 3 例——实例/模块新增变量被切片引用必须 typeof 守卫已三令五申） → v270 用户实机验收四修：①「项目」范围按用户口径重定义=全部项目对比（原当前项目与「会话」差异过小，用户实报「应该是取 zcode 所有的项目」；默认维度按项目，dims=[project,time]，不再按 panePid 过滤，切到项目时 session 维度归 project）；②维度切换后 Tab 无效——结合①数据差异过小造成「无反应」假象，随①消除；③右上时间胶囊月日前带年（跨年两端各自带年）；④hover 卡时间行同日区间压缩（右侧只补时分秒）+ zu-sv-twrap 允许换行，长区间不再省略号截断 → v271 点击任意位置关闭根治（用户实报）：tip 内按压后 1.2s 硬保活窗——hideTip 对非 win-leave/escape 的 force 一律降级交总闸（left-bar 命中区边缘误判/焦点跌落/宿主重渲染等任何路径）、focusout 在窗内直接不关；pointerdown 记 lastTipDownAt（typeof 守卫兼容切片）；win-leave（真失焦）与 Escape 保留立即收 → v272 维度切换功能移除（用户裁定）：图表恒按时间聚合——删图表头维度下拉（tip+tpsTip 两处 change 委托、dimSel 拼装、四条 CSS）、speedTabActivate/tpsTabActivate 的 dim 归位规则；「项目」范围恢复当前项目语义（恒时间维度下「全部项目」与「全部」完全等价），标题加「当前项目 ·」前缀；speedSel.dim 结构保留恒 time（会话切换重置兼容） → v273 自适应布局+稀疏可视化+筛选栏重设计（用户 8 张截图 Goal）：①plot 自适应——删 inline 定宽，in-flow spacer（max(240, n*30+12)px）撑宽 + min-width:calc(100% - 30px) 拉满容器，柱组 flex 居中，多桶 spacer 触发横滚，网格/Y 轴/hover 共享同一 plot 坐标系（少柱不再左侧堆积大空白）；②hover 卡锚点改中心相对式 left:calc(50% + off)（plot 宽不再可算）；③today 有效桶 ≤3 且全桶 ≥4 默认聚焦有效时段，图表头「显示完整时间轴/仅显示有记录时段」次级按钮切换（speedSel.focus，切筛选重置，不改统计口径），聚焦带「仅显示有记录时段」提示；④数据覆盖提示 zu-sc-cov：今天「有记录 x/M 小时」、近 7 天「仅 x/7 天有记录」、本月「本月 x/N 天有记录」（分母=已发生时段，不含未来）；⑤筛选工具栏两端对齐——范围组左、时间组右（.zu-sv-time margin-left:auto），删分隔符，与统计卡/图表两缘对齐；⑥左卡精简——删「不含进行中请求」，实时状态并入标题行右侧轻量 zu-sl-sub（不再混入指标间），单柱时峰值/最低/最新 zu-sl-solo 弱化；⑦时间胶囊智能格式——同日「MM/DD HH:MM – HH:MM」、跨日不带年、跨月/跨年两端带年（v270 全带年撤销）；会话切换 speedSel.focus 重置 → v274 完整规格补齐（第二轮 Goal）：①spdChartLayout 统一布局参数入口（colPitch/spacerW/xEvery/valEvery 单处决定）；②柱顶数值稀疏化 valShown——n>8 按 ceil(n/8) 抽稀、首末与悬停柱恒显，16 柱不再数值重叠（hover 卡兜底完整值）；③最新柱 latest 弱化描边；④单点/双点 coverage 追加「暂无足够数据观察趋势」；⑤空态追加「尝试选择更长时间范围」弱化引导；⑥bkeys 截尾仅剩 recent（v273 聚焦改造时已自然移除非 recent 截断，超宽由 spacer 横滚承接不丢桶） → v275 点击偶发关闭+快速切换卡死双修（用户实报）：①tip 原生 pointermove 直接保活（mousemove 处理器 150ms 节流采样盲区让 mouseInBar 停留 false，left-bar 等 force 路径就能关掉交互中 tooltip；pointermove 高频纯赋值绕开节流盲区，总闸始终可靠）；②整卡重编 rAF 合并 scheduleSpeedRebuild——快速来回切 Tab 每次指针按下同步 innerHTML 重建形成重建风暴（卡死体感），同帧多次切换只重建一次，切片沙箱无 rAF 自动退回同步（既有 pointerdown 契约测试不变）；③dispose 取消待合并 rAF；④tipStats.hideSeq 最近 8 次收起原因序列（diag 定性偶发关闭）
    /* issue #55：这三个 var 必须先于下方 buildPanel() 的调用完成赋值——var 只提升声明不提升
     * 赋值，而 buildPanel → syncUpdate 首轮执行就会读它们（赋值语句曾排在调用点之后，
     * v1.5.2 首轮读到 undefined 抛 TypeError 拖垮实例创建）。配套函数是声明有提升，留在原位。 */
    var instanceDisposed = false, heavyTimer = 0, frame = 0, themeObserver = null;
    var detRootEl = null;   // v174：本实例会话根（最近 data-session-id 祖先），随 setComposer 更新
    var globalListeners = [];
    function listenGlobal(target, type, fn, capture) {
      target.addEventListener(type, fn, capture);
      globalListeners.push([target, type, fn, capture]);
    }
    function inactive() { return instanceDisposed || stale(); }
    /* ---------- 状态（实例级） ---------- */
    var excOn = false,    // 本 pane 会话处于"上下文超限被拒"状态（render 时按 picked 会话计算）
      excGone = false,    // 用户点 ✕ 关闭了本次气泡；超限解除后自动复位
      nativeCtxVal = 0,   // 本 pane 输入框卡片上读到的原生上下文总量
      lastSub = null,     // 子代理明细面板数据源
      instSid = "",       // 本 pane 当前会话（composer 祖先链 data-session-id）
      pendingSid = "", wantedEl = null, scopeStamp = "",   // 协调器派发的最新 composer/会话
      shrink = 0,         // 分级收缩（v66）：1 = 内容超卡片宽，「本轮/会话累计」缓存命中率已让位
      fadeOn = false,     // 收缩后仍超宽：右缘渐隐（.zu-clip）
      bridge = { handle: null, turnId: "", timer: 0 },   // v71 本 pane 的 renderer store 订阅
      lastBand = null,    // v92：本 pane 上下文分档（ctxBandOf 结果，原生按钮增强的数据源）
      ctxBtnCache = null,   // v92：本实例上次增强的原生按钮（还原/对账引用，不依赖 cardCache 存活）
      lastQuota = null, lastQuotaAll = null, lastResets = null, quotaProvider = "", quotaModel = "", quotaFallback = "", quotaChipCache = null,
      quotaSourceId = "", quotaSelection = null, quotaPaneRoot = null, quotaSelectionObserver = null, quotaMarkerSeen = false,   // 当前 pane 模型选择与额度来源
      gitChipCache = null, gitRefreshPath = "", gitRefreshRequestId = "",   // Git chip 节点与刷新状态
      liveTextCur = "", liveStatsCur = null, liveKindCur = "fallback", liveEl = null,   // v72：合并「生成速度」用
      livePhaseCur = "", liveIconCur = "bolt",   // v77：当前 chip 阶段与图标（think=思考动效/bolt=闪电）——相位切换需整条重渲染
      tpsChipCache = null, lastView = null,   // v146：精简模式工具行速率 chip 与最近一次 render 会话视图（chip tooltip 摘要数据源）
      speedChartHover = -1, speedTipSess = "", speedTipRebuild = null,   // v232 速度柱状图：悬停段下标（-1=最新段）/归属会话守卫/tip 重建闭包
      speedSel = { range: "recent", period: "recent", dim: "time" },   // v254 双 Tab + 维度（实例级，会话切换重置）
      speedInteractAt = 0,   // v254 最近一次 Tab/维度/柱 hover 交互时刻（updateLive 短冻结防打断）
      compactHid = false;   // v156：display:none 是否由精简模式设置（区分初载 none，避免切档前提前露条）

    /* ---------- DOM ---------- */
    /* 样式表挂在 bar 内部而非 head：React 可能清理 head 里的外来 style，
     * CSS 一旦失效条就退化成 static 占位元素（"输入框下方空白"的历史根因）。 */
    var style = document.createElement("style");
    style.textContent =
      /* 胶囊条：半透明底 + 微边框（v80 起仅 below-card 兜底形态用；in-card 形态由
       * .zusage-root.zu-in 全部抹平）。配色全量跟随客户端主题（v58）：颜色一律
       * var(--color-*, 旧值兜底) 引用客户端语义变量（<html> 的 .dark 类翻转整套值，
       * zai-light/zai-dark 特殊主题同样自动适配）；color-mix 处加同值前置声明，
       * 不支持 color-mix 的旧引擎落到实色行不至于透明。 */
      ".zusage-root{position:fixed;box-sizing:border-box;" +
      "font-family:var(--font-mono,Consolas,'Cascadia Mono',Menlo,'Microsoft YaHei UI','Microsoft YaHei',monospace);" +
      "font-size:var(--ui-font-size,14px);line-height:1.3;" +
      "font-variant-numeric:tabular-nums;color:var(--color-foreground-subtle,#8791a3);" +
      "background:rgba(15,18,25,.86);background:color-mix(in srgb,var(--color-background,#0f1219) 86%,transparent);" +
      "backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);" +
      "border:1px solid var(--color-border,rgba(255,255,255,.07));border-radius:9px;padding:2px 6px;user-select:none;" +
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 4px 14px rgba(0,0,0,.38),0 1px 3px rgba(0,0,0,.28);" +
      "display:flex;align-items:center;gap:2px;white-space:nowrap;" +
      /* 条不用 overflow:hidden：超宽截断由 #zu-main 自己负责（渐隐 .zu-clip）。 */
      "z-index:50}" +
      /* in-card 形态（v80）：条挂在输入卡片内部 group/toolbar 工具行之后自占一行，
       * 与对话框融为一体——背景/边框/阴影/毛玻璃全抹掉（用户指定），宽度交由卡片
       * flex-col 的 stretch 撑满内宽（min/max-width 不再写死）。 */
      ".zusage-root.zu-in{position:static;background:none;border:0;border-radius:0;padding:1px 0 0;" +
      "box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;min-width:0;max-width:none;z-index:auto}" +
      ".zusage-root.zu-pill{width:max-content;min-width:0;max-width:calc(100vw - 16px);padding:2px 6px;" +
      "background:var(--zu-pill-bg,var(--color-input,var(--color-background,#13161e)));" +
      "border-width:var(--zu-pill-border-width,1px);border-style:var(--zu-pill-border-style,solid);" +
      "border-color:var(--zu-pill-border-color,var(--color-input-border,var(--color-border,transparent)));" +
      "border-radius:var(--zu-pill-radius,12px);backdrop-filter:none;-webkit-backdrop-filter:none}" +
      ".zusage-root.zu-pill .zu-main{flex:0 1 auto;justify-content:flex-start;overflow-x:auto;scrollbar-width:thin}" +
      ".zusage-root.zu-pill .ico{color:var(--color-brand,#3b82f6)}" +
      ".zu-main{overflow:hidden;min-width:0;flex:1 1 auto;display:flex;align-items:center;gap:1px;justify-content:space-between}" +
      /* v226 水平对齐（仅默认档挂类）：居左直接改 justify；居右不用字面 flex-end——LTR 下 start 侧
       * 溢出不可滚动也不计入 scrollWidth，收缩检测会失效、左格无声硬裁、.zu-clip 渐隐错边；改用首格
       * margin-left:auto 吸收自由空间等效右聚拢，溢出时 auto 归零、内容右向溢出，收缩/渐隐兜底不变 */
      ".zusage-root.zu-just-start .zu-main{justify-content:flex-start}" +
      ".zusage-root.zu-just-end .zu-main > :first-child{margin-left:auto}" +
      /* 收缩兜底（v66）：分级收缩后仍装不下时右缘 26px 渐隐，替代生硬的截断 */
      ".zu-main.zu-clip{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent);" +
      "mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent)}" +
      /* zu-main 不得带 .it class：querySelectorAll('.it') 收集 tooltip 时会把它算进第 0 位，
       * tips 全部错位一位且末项为 null —— v31"悬停只有空胶囊/内容错位"的根因 */
      ".it{display:flex;align-items:center;gap:5px;padding:2px 7px;border:0;border-radius:7px;" +
      "background:transparent;color:inherit;font:inherit;line-height:inherit;text-align:left;white-space:nowrap;" +
      "transition:background-color .12s ease-out,color .12s ease-out}" +
      ".it:hover,.it:focus-visible{background:var(--color-hover,rgba(255,255,255,.06))}" +
      ".it:focus-visible,.zu-gear:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c8ff))!important;outline-offset:2px}" +
      ".zu-gear{flex:0 0 auto;position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;" +
      "border:0;background:transparent;color:var(--color-foreground-subtle,#a1a1a1);font:inherit;line-height:1;cursor:pointer}" +
      ".zu-gear>svg{width:var(--ui-font-size,14px);height:var(--ui-font-size,14px);display:block;transform:translateY(-.5px)}" +
      /* v172 待办红点：待重启/有新版时亮（syncUpdate 按 restartRequired/phase 控制），crit 色呼吸 */
      ".zu-gear-dot{position:absolute;top:1px;right:1px;width:7px;height:7px;border-radius:50%;background:#ff6b57;display:none;animation:zupulse 1.6s ease-in-out infinite}" +
      ".zu-gear:hover{color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".it.zu-sub{appearance:none;-webkit-appearance:none;cursor:pointer}" +
      ".it.zu-sub:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c8ff))!important;outline-offset:2px}" +
      ".sep{width:1px;height:15px;background:var(--color-border,rgba(255,255,255,.09));flex:0 0 auto;margin:0 3px}" +
      ".k{color:var(--color-foreground-subtle,#a1a1a1)}.v{color:var(--color-foreground,#e9edf4);font-weight:600}" +
      ".zu-live{color:var(--color-foreground,#e9edf4);font-weight:600}" +
      /* v176 子代理行内速率 chip：挂宿主 v4 Agent 行 .tool-summary-content 之后，颜色走
       * TPS 十档类（与条面同源），数字 tabular 不抖宽；cursor:help 提示可悬停看口径。 */
      ".zu-subrate{flex:0 0 auto;white-space:nowrap;cursor:help;font-size:12px;line-height:1.4;font-weight:600;font-variant-numeric:tabular-nums}" +
      /* v159 状态词流光（用户规格）：复刻宿主 .zcode-loading-label 同款参数——subtle→foreground→subtle
       * 横向渐变 background-clip:text 扫光 1.4s；类名/关键帧自有命名，不依赖宿主全局类防其改版。
       * reduced-motion 停动画（与宿主一致，渐变停在可见段）。 */
      "@keyframes zu-loading-shimmer{0%{background-position:200% 0}to{background-position:-200% 0}}" +
      ".zu-live.zu-shimmer{background-image:linear-gradient(90deg,var(--color-foreground-subtle,#8791a3) 35%,var(--color-foreground,#e9edf4) 50%,var(--color-foreground-subtle,#8791a3) 65%);color:#0000;-webkit-text-fill-color:transparent;background-position:200% 0;background-size:200% 100%;-webkit-background-clip:text;background-clip:text;font-weight:500;animation:1.4s linear infinite zu-loading-shimmer;display:inline-block}" +
      "@media (prefers-reduced-motion:reduce){.zu-live.zu-shimmer{animation:none;background-position:50% 0}}"+
      ".dim{color:var(--color-foreground-subtle,#a1a1a1);font-weight:400}" +
      /* 三档状态色刻意不走客户端变量（v58.1）：terminal-bright-* 是语法高亮色板，
       * 绿档在条面小字号/细进度条上发白（用户实测）；改用高对比自调档，
       * 浅色加深版在 .zu-light 组。 */
      ".ok{color:#3ecf8e}.warm{color:#f5b944}.hot{color:#ff6b57}" +
      /* v127 速度十档新增蓝紫系（阈值唯一事实源 = JS TPS_BANDS，CSS 只按类给色）。
       * ≥2000 Ultra：静态蓝紫渐变（background-clip:text 染字），@supports 外回退
       * 中间站纯紫；✦ 星点用 content:"✦"/"" 生成——替代文本为空，屏幕阅读器读不到、
       * 不占 textContent（原地改字路径零改动），静态无动画不发光。 */
      ".zu-teal{color:#2dd4bf}.zu-sky{color:#38bdf8}.zu-azure{color:#6d9fff}" +
      ".zu-violet{color:#9b8cff}.zu-purple{color:#bb86fc}.zu-magenta{color:#d88cff}" +
      ".zu-ultra{color:#a78bfa}.zu-ultra::before{content:\"✦\"/\"\";margin-right:2px}" +
      "@supports(-webkit-background-clip:text){" +
      ".zu-ultra{background:linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%);" +
      "-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}" +
      ".zu-ultra::before{background:linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%);" +
      "-webkit-background-clip:text;background-clip:text}}" +
      /* 超限=亮红呼吸闪烁（v38 定性"亮红闪烁优先于一切档位"，v54 落成动画） */
      "@keyframes zuexc{0%,100%{opacity:1}50%{opacity:.4}}" +
      ".exc{color:var(--color-destructive,#ff2d55);text-shadow:0 0 8px rgba(255,45,85,.5);animation:zuexc 1.1s ease-in-out infinite}" +
      ".btn{cursor:pointer;padding:2px 6px;border-radius:6px;color:var(--color-foreground-subtle,#7e8899);" +
      "transition:background-color .12s ease-out,color .12s ease-out}" +
      ".btn:hover{color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".btn:active{transform:scale(.96)}" +
      /* 图标盒 = 宿主字号（.zu-gear>svg 同值）：24 格线性图标墨迹只占盒的 75%–83%，等字号盒下墨迹介于数字字高与中文字面之间；
       * 不加 +Npx 常量——加法会让比例随字号漂移（14px 时 1.29×、20px 时 1.2×）。数字字面略高于行盒中心，轮廓上移半像素作光学校正。 */
      ".zusage-root .ico{display:block;width:var(--ui-font-size,14px);height:var(--ui-font-size,14px);" +
      "flex:0 0 auto;align-self:center;overflow:visible;color:var(--color-foreground-subtle,#a1a1a1);opacity:1;transform:translateY(-.5px)}" +
      ".zusage-root .it{line-height:1.3}.zusage-root .it>span:not(.eb){display:inline-flex;align-items:center;min-height:1.3em}" +
      ".zusage-root .eb .ico{width:12px;height:12px;transform:none}" +
      ".zusage-root .zu-think{color:var(--color-brand,#8171e8);opacity:1}" +
      /* 工具错误数徽标 */
      ".eb{background:rgba(255,107,87,.14);background:color-mix(in srgb,var(--color-destructive,#ff6b57) 14%,transparent);" +
      "color:var(--color-destructive,#ff8a73);border-radius:999px;padding:0 6px;line-height:16px;font-weight:600;display:inline-flex;align-items:center;gap:2px}" +
      ".eb .ico{color:inherit}" +
      /* v92 原生上下文按钮增强（原状态条「上下文容量」格 v93 删除，档位口径由本处承载）：四档色由 data-zusage-band 驱动 —— React
       * 不清理非 props 的手动属性；!important 压原生 text-success/text-warning/
       * text-foreground-subtle 变调；静态几何（r/描边/圆帽/透明度）用 CSS 覆盖
       * presentation attribute（永远生效），动态 pathLength/dasharray 由
       * enhanceCtxButton 写入。exc 复用 zuexc 呼吸闪烁。数值挂按钮内（环右侧）：
       * 悬停自动享受原生 hover:bg-hover 与「上下文容量」面板，width 由固定方形放开。 */
      "[data-testid=chat-context-usage-trigger][data-zusage-armed]{color:#3ecf8e!important;" +
      "width:auto!important;min-width:1.75rem;padding:0 3px;gap:4px}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=norm]{color:#3ecf8e!important}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=mid],[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=high]{color:#f5b944!important}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=crit]{color:#ff6b57!important}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed][data-zusage-band=exc]{color:var(--color-destructive,#ff2d55)!important;" +
      "text-shadow:0 0 8px rgba(255,45,85,.5);animation:zuexc 1.1s ease-in-out infinite}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed]>svg:not(.animate-spin) circle{opacity:1;stroke-width:3;r:9px}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed]>svg:not(.animate-spin) circle:first-of-type{stroke:var(--color-hover,rgba(255,255,255,.1))}" +
      "[data-testid=chat-context-usage-trigger][data-zusage-armed]>svg:not(.animate-spin) circle:last-of-type{stroke:currentColor;stroke-linecap:round}" +
      /* v133：与额度 chip 同字体（14px 加粗等宽，显式声明不依赖按钮的 text-ui-base 链） */
      ".zu-ctxpct{display:inline-flex;align-items:center;flex:0 0 auto;" +
      "font-family:var(--font-mono,Consolas,'Cascadia Mono',Menlo,'Microsoft YaHei UI','Microsoft YaHei',monospace);font-size:calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px);font-weight:700;font-variant-numeric:tabular-nums}" +
      /* 浅色档（与 .zu-light 组同源深化值）：标记由 enhanceCtxButton 随 bar 主题同步到
       * button（pct span 与环都在按钮内，同为 data-zusage-light 后代）。 */
      /* 浅色档必须带 [data-zusage-armed] 补足特异性（0,3,0）：否则暗色三属性档位规则
       * (0,3,0) 恒胜浅色两属性规则 (0,2,0)，浅色主题下 norm~crit 全部显示暗色档色 */
      "[data-zusage-light][data-zusage-armed][data-zusage-band=calm],[data-zusage-light][data-zusage-armed][data-zusage-band=norm]{color:#0f9d6c!important}" +
      "[data-zusage-light][data-zusage-armed][data-zusage-band=mid],[data-zusage-light][data-zusage-armed][data-zusage-band=high]{color:#b6791a!important}" +
      "[data-zusage-light][data-zusage-armed][data-zusage-band=crit]{color:#d8482f!important}" +
      "[data-zusage-light][data-zusage-armed][data-zusage-band=exc]{text-shadow:none}" +
      /* v131 pct span 与环一律继承按钮 currentColor（band 色唯一来源=上方 data-zusage-band
       * 规则），图标与文字天然同色；v127 的 .zu-ctxpct.ok/warm/hot 独立色随五档规格废止 */
      "[data-zusage-light] .zu-ctxpct.exc{text-shadow:none}" +
      /* v135 重置卡徽标（.zu-ctxrst，pct 右侧）：字体与 .zu-ctxpct 同链（14px 加粗等宽
       * tabular-nums）；三档色沿用额度三色（用户规格 2026-10-28），crit 加 zupulse 呼吸
       * （与 .zu-quota.zu-qbusy 同动画）；浅色档由按钮 data-zusage-light 后代选择器换装 */
      ".zu-ctxrst{display:inline-flex;align-items:center;flex:0 0 auto;white-space:nowrap;" +
      "height:1.75rem;padding:0 3px;border-radius:.5rem;cursor:default;" +   /* 左右 3px（用户规格 2026-11-02，原 6px） */
      "font-family:var(--font-mono,Consolas,'Cascadia Mono',Menlo,'Microsoft YaHei UI','Microsoft YaHei',monospace);font-size:calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px);font-weight:700;font-variant-numeric:tabular-nums}" +
      ".zu-ctxrst:hover{background:var(--color-hover,rgba(255,255,255,.08))}" +   // 与额度/Git chip 同款 hover 视格（用户反馈 2026-10-28）
      ".zu-ctxrst>svg{margin-right:3px}" +   // 图标↔数字间距（用户规格 2026-10-28 调优）
      ".zu-ctxrst.zu-rst-calm{color:#3ecf8e}" +
      ".zu-ctxrst.zu-rst-mid{color:#f5b944}" +
      ".zu-ctxrst.zu-rst-crit{color:#ff6b57;animation:zupulse 1s ease-in-out infinite}" +
      "[data-zusage-light] .zu-ctxrst.zu-rst-calm{color:#0f9d6c}" +
      "[data-zusage-light] .zu-ctxrst.zu-rst-mid{color:#b6791a}" +
      "[data-zusage-light] .zu-ctxrst.zu-rst-crit{color:#d8482f}" +
      /* v209 模型选择触发按钮（chat-model-select-trigger）左内边距减半（用户规格 2026-11-02）：
       * 文本态 pl-2 8px→4px；图标态（composer-model-icon）px-1.5 6px→3px。宿主 group 变体
       * 选择子特异性可达 (0,3,0)，用 !important 压制；图标态由第二条（同为 important、特异性
       * 更高）覆盖第一条取 3px。纯 CSS 不动宿主 DOM，随 <style> 生命周期生效/消失。 */
      "[data-testid=chat-model-select-trigger]{padding-left:4px!important}" +
      "[data-composer-model-icon=true] [data-testid=chat-model-select-trigger]{padding-left:3px!important}" +
      /* v136 编辑项目弹窗源文件夹完整路径（⚙ 通用区开关，纯 CSS 伪元素，零 DOM 注入）：
       * 宿主行的 span 恒挂完整路径 title、正文只显示末段（getPathLeaf）；::after 取
       * attr(title) 在名称下方补一行完整路径——不插任何节点，React 调和/增删文件夹/
       * 重开弹窗都无感，无需观察器与对账。.truncate 正向限定本地行（fixedFolder 远端行
       * 用 break-all 直接显示全路径，排除防重复）；多文件夹每行各取各的 title。宿主
       * truncate 的 nowrap 继承进伪元素，须显式 white-space:normal 恢复换行（用户规格
       * 2026-10-28：长路径自动换行、不做省略号）；break-all 与宿主 fixedFolder 行同款。
       * 规则由 <html> 的 data-zusage-pp 门控（applyProjPath），关闭即整体失效。 */
      '[data-zusage-pp="1"] [data-testid=virtual-project-root-name].truncate::after{content:attr(title);' +
      "display:block;white-space:normal;word-break:break-all;" +
      "font-size:var(--text-ui-sm,calc(var(--ui-font-size,14px) - 2px));line-height:1.45;" +
      "color:var(--color-foreground-subtle,#8791a3)}" +
      "[data-zusage-pp=\"1\"] [data-testid=virtual-project-root-name].truncate{cursor:pointer}" +   // v137：整行可点开文件管理器
      /* v146 宿主命令中心（⌘K 搜索弹框）加宽加高（⚙ 通用区开关）：宽度上限是宿主共享常量
       * quickPickDialogClassName 的 max-w-lg=512px（ZCode packages/ui quickpick/quickPickStyles.ts），
       * 弹框基础类自带 w-full + left-1/2 -translate-x-1/2（窄窗本就满宽），故只放宽 max-width：
       * max(32rem,80vw) 小窗保持原样、大窗放宽到窗口 80%。高度同规格：实际高度由 cmdk 列表
       * 驱动，其原生 max-h-[min(440px,calc(100dvh-15rem))] 的 440px 硬顶（CommandCenterDialog
       * commandCenterListClassName）才是"矮"的主因，放宽为 max(440px,calc(90dvh-15rem))
       * （15rem 沿用宿主非列表段余量结构），小窗 90dvh-15rem<440px 时保持原样；弹框根上限
       * 取 max(90dvh,calc(100dvh-6rem))——不低于原生 sm:max-h-[calc(100dvh-6rem)]，任何窗口
       * 不缩矮，根 90dvh 顶住时列表 overflow-y-auto 收缩滚动。:has 限定 cmdk 弹框（命令中心/
       * 任务搜索/快捷指令三弹框共用该样式常量，一并放宽），设置页等普通 Dialog 不含
       * cmdk-root 不受影响。属性值必须带引号：未加引号的数字值会让 Chrome 丢弃整条规则
       * （v136 实测）。规则由 <html> 的 data-zusage-cmdk 门控（applyCmdkW），关闭即整体失效。 */
      "[data-zusage-cmdk=\"1\"] div[data-slot=dialog-content]:has(>[data-slot=command][cmdk-root])" +
      "{max-width:max(32rem,80vw)!important;max-height:max(90dvh,calc(100dvh - 6rem))!important}" +
      "[data-zusage-cmdk=\"1\"] [data-slot=dialog-content] [cmdk-list]" +
      "{max-height:max(440px,calc(90dvh - 15rem))!important}" +
      /* v96 Git 状态 chip（工具行「电脑操作」按钮右侧）：外形对齐原生 ghost 按钮（h-7/rounded-lg/
       * px-1.5/gap-1）；配色移植 cc-pretty-statusline 的 git 段——图标+分支名暗灰，+插入绿 /
       * -删除红 / ?未跟踪黄，括号与 ↑↓ 随暗灰；浅色档（Catppuccin Latte 同源值）由 syncCtxLite
       * 写在 chip 自身的 data-zusage-light 切换。 */
      ".zu-git{display:inline-flex;align-items:center;gap:4px;height:1.75rem;padding:0 .375rem;border-radius:.5rem;" +
      "flex:0 0 auto;box-sizing:border-box;cursor:pointer;user-select:none;white-space:nowrap;outline:none;" +
      "font-family:var(--font-mono,Consolas,'Cascadia Mono',Menlo,'Microsoft YaHei UI','Microsoft YaHei',monospace);" +
      "font-size:var(--ui-font-size,14px);line-height:1;font-variant-numeric:tabular-nums;color:#afafb2;transition:background-color .15s}" +
      ".zu-git:hover,.zu-git:focus-visible{background:var(--color-hover,rgba(255,255,255,.08))}" +
      ".zu-git:focus-visible,.zu-quota:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c8ff))!important;outline-offset:2px}" +
      ".zu-git>svg{width:16px;height:16px;flex:0 0 auto}" +
      ".zu-git .zu-git-ins{color:#aae6aa}" +
      ".zu-git .zu-git-del{color:#f09696}" +
      ".zu-git .zu-git-unt{color:#f0e6a0}" +
      ".zu-git-conflict{color:#f09696}" +
      ".zu-git-warn{color:#f0e6a0}" +
      ".zu-git-op{color:#afafb2}" +
      ".zu-git-sep{opacity:.6;padding:0 2px}" +   /* v212 间距收紧（用户规格 2026-11-02）：原靠字面空格「 · 」，视觉偏宽；改纯点+2px 内边距 */
      ".zu-git.zu-compact .zu-git-name,.zu-git.zu-compact .zu-git-ab{display:none}" +
      ".zu-git.zu-compact.zu-git-multi .zu-git-d{display:none}" +   // v96 multi 紧凑：聚合计数段一并收起（单仓紧凑保留行数段）
      "@keyframes zugitspin{to{transform:rotate(360deg)}}" +
      ".zu-git.zu-gbusy>svg{animation:zugitspin .8s linear infinite}" +
      ".zu-git[data-zusage-light]{color:#6c6f85}" +
      ".zu-git[data-zusage-light] .zu-git-ins{color:#2da587}" +
      ".zu-git[data-zusage-light] .zu-git-del{color:#d20f39}" +
      ".zu-git[data-zusage-light] .zu-git-unt{color:#df8e1d}" +
      ".zu-git[data-zusage-light] .zu-git-conflict{color:#d20f39}" +
      ".zu-git[data-zusage-light] .zu-git-warn{color:#946200}" +
      ".zu-git[data-zusage-light] .zu-git-op{color:#626579}" +
      /* v96 multi：脏仓段黄（有冲突时 .zu-conflict 整段红）+ 聚合改动计数 M 黄；浅色档同源深化/加浓值 */
      ".zu-git .zu-git-dirty{color:#f0e6a0}" +
      ".zu-git.zu-conflict .zu-git-dirty{color:#f09696}" +
      ".zu-git .zu-git-m{color:#f0e6a0}" +
      ".zu-git[data-zusage-light] .zu-git-dirty{color:#df8e1d}" +
      ".zu-git[data-zusage-light].zu-conflict .zu-git-dirty{color:#d20f39}" +
      ".zu-git[data-zusage-light] .zu-git-m{color:#df8e1d}" +
      /* v96 套餐额度 chip（原生上下文按钮左侧，wrapper 内前插）：多窗分段样式——每个窗口
       * 一段（中文 5小时/7天，英文 5h/7d）各自按 QUOTA_BANDS 上档位色；余额类型单段
       * （阶段 3 数据源接入即显示）；容器不着色，颜色只落在分段上。 */
      /* v133 字体显式声明（用户规格 2026-10-28 定稿）：14px（--ui-font-size）+ 加粗 + 等宽 +
       * tabular-nums，额度与上下文百分比两处恒等——不再靠继承（工具栏容器字号偏小、
       * 与带 text-ui-base 的按钮不等高，实测两段字号不一致）。 */
      ".zu-quota{display:inline-flex;align-items:center;gap:5px;height:1.75rem;padding:0 3px;border-radius:.5rem;cursor:pointer;user-select:none;flex:0 0 auto;" +   /* 左右 3px（用户规格 2026-11-02，原 6px；.zu-tsb 不随动） */
      "font-family:var(--font-mono,Consolas,'Cascadia Mono',Menlo,'Microsoft YaHei UI','Microsoft YaHei',monospace);font-size:calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px);font-weight:700;font-variant-numeric:tabular-nums}" +
      ".zu-quota:hover,.zu-quota:focus-visible{background:var(--color-hover,rgba(255,255,255,.08));outline:none}" +
      /* 额度 chip 三档视觉（用户规格 2026-10-28）：绿/黄/红映射 QUOTA_BANDS 五档阈值——
       * calm+norm(<50) 绿、mid+high(50–89) 黄、crit(90–99) 红，阈值表不动仅色值收敛；
       * exc(≥100) 独立异常态仍走 destructive+光晕+呼吸（视觉归红）。dim=无数据中性态保留。 */
      ".zu-qseg{white-space:nowrap}" +
      ".zu-qseg.zu-qb-calm,.zu-qseg.zu-qb-norm{color:#3ecf8e}" +
      ".zu-qseg.zu-qb-mid,.zu-qseg.zu-qb-high{color:#f5b944}" +
      ".zu-qseg.zu-qb-crit{color:#ff6b57}" +
      ".zu-qseg.zu-qb-exc{color:var(--color-destructive,#ff2d55);text-shadow:0 0 8px rgba(255,45,85,.5);animation:zuexc 1.1s ease-in-out infinite}" +   /* ≥100% 满档：呼吸闪烁保留（用户规格） */
      ".zu-qseg.dim{color:#9a9a9a}" +   /* v111 中性提示段（额度 未配置/暂不支持） */
      ".zu-qsep{color:var(--color-foreground-subtle,rgba(255,255,255,.28));font-weight:400;font-size:.8em;line-height:1;transform:translateY(-1px)}" +
      ".zu-quota.zu-qstale{opacity:.6}" +
      ".zu-quota.zu-qbusy{animation:zupulse 1s ease-in-out infinite}" +
      ".zu-quota .zu-qwarn{font-size:.85em;line-height:1}" +
      ".zu-quota[data-zusage-light] .zu-qseg.zu-qb-calm,.zu-quota[data-zusage-light] .zu-qseg.zu-qb-norm{color:#0f9d6c}" +
      ".zu-quota[data-zusage-light] .zu-qseg.zu-qb-mid,.zu-quota[data-zusage-light] .zu-qseg.zu-qb-high{color:#b6791a}" +
      ".zu-quota[data-zusage-light] .zu-qseg.zu-qb-crit{color:#d8482f}" +
      ".zu-quota[data-zusage-light] .zu-qseg.zu-qb-exc{text-shadow:none}" +
      ".zu-quota[data-zusage-light] .zu-qseg.dim{color:#8a8a8a}" +
      /* v146 精简模式速率 chip（.zu-tsb）：挂工具行、重置卡左侧；字体显式规格与 .zu-quota
       * 同源（--text-ui-base-1px + 700 + 等宽 + tabular-nums，用户规格 2026-10-28 对齐）。
       * 速率色档复用全局 .ok/.warm/.hot 与 TPS 十档类（含 Ultra 渐变 ✦）；浅色组靠 chip
       * 自身的 .zu-light 类补链（条隐藏后 .zu-light 祖先缺失）。 */
      ".zu-tsb{display:inline-flex;align-items:center;gap:5px;height:1.75rem;padding:0 6px;border-radius:.5rem;cursor:pointer;user-select:none;flex:0 0 auto;" +
      "font-family:var(--font-mono,Consolas,'Cascadia Mono',Menlo,'Microsoft YaHei UI','Microsoft YaHei',monospace);font-size:calc(var(--text-ui-base,var(--ui-font-size,14px)) - 1px);font-weight:700;font-variant-numeric:tabular-nums}" +
      ".zu-tsb:hover,.zu-tsb:focus-visible{background:var(--color-hover,rgba(255,255,255,.08));outline:none}" +
      /* 阶段 3 ⚙ 源列表（v103 布局）：每源一张圆角小卡片（dsh QuotaCard 同款），卡片间距与
       * 内边距呼吸开；凭据框限宽不拉满；说明段落（card 直子 pnote）补水平边距 */
      ".zu-src-list{display:flex;flex-direction:column;gap:8px;padding:4px 12px 12px}" +
      ".zu-src-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 12px 11px;" +
      "border:1px solid var(--color-border,rgba(255,255,255,.08));border-radius:10px}" +
      ".zu-src-name{display:flex;align-items:center;gap:8px;flex:0 0 auto;font-weight:600}" +
      ".zu-src-status{flex:1 1 auto;min-width:0;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-src-feedback:empty{display:none}.zu-src-feedback{flex-basis:100%;min-height:1.35em;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size,14px) - 2px);overflow-wrap:anywhere}" +
      ".zu-feedback-error{color:var(--color-destructive,#d8482f)}" +
      ".zu-src-refresh{background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px}" +
      ".zu-src-refresh:disabled{opacity:.4;cursor:default}" +
      ".zu-src-refresh[aria-busy=true]{animation:zupulse 1s ease-in-out infinite;cursor:progress}" +
      ".zu-src-refresh:hover{color:var(--color-foreground,#fafafa)}" +
      ".zu-src-fields{flex-basis:100%;display:flex;gap:8px;flex-wrap:wrap}" +
      ".zu-src-field{flex:1 1 220px;max-width:420px;min-width:0;background:var(--color-input,rgba(0,0,0,.25));border:1px solid var(--color-foreground-subtle,#8791a3);border-radius:6px;color:inherit;padding:4px 9px;font-family:var(--font-mono,monospace);font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      /* v102 预设模板：官方域变体一键填充 chip + 控制台取 Key 链接 */
      ".zu-src-presets{flex-basis:100%;display:flex;gap:6px;flex-wrap:wrap;align-items:center}" +
      ".zu-src-preset{background:none;border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:999px;" +
      "color:var(--color-foreground-subtle,#8791a3);font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.4;padding:1px 9px;cursor:pointer}" +
      ".zu-src-preset:hover{color:var(--color-foreground,#e9edf4);border-color:var(--color-border-hover,rgba(255,255,255,.22))}" +
      ".zu-src-preset.on{color:var(--color-brand,#57c7ff);border-color:var(--color-brand,#57c7ff)}" +
      ".zu-src-keyurl{background:none;border:0;color:var(--color-brand,#57c7ff);font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.4;padding:2px 4px;cursor:pointer;white-space:nowrap}" +
      ".zu-src-keyurl:hover{text-decoration:underline}" +
      /* v128 模型拉取：供应商行卡片 + body 级选择弹窗（.panel 同族变量配色，浅深主题随变量） */
      ".zu-mp-list{display:flex;flex-direction:column;gap:8px;padding:4px 0 0}" +
      ".zu-mp-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 12px;border:1px solid var(--color-border,rgba(255,255,255,.08));border-radius:10px}" +
      ".zu-mp-pick{width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer}" +
      ".zu-mp-pick:hover{background:var(--color-hover,rgba(255,255,255,.06))}" +
      ".zu-mp-sub{color:var(--color-foreground-subtle,#8791a3);font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      ".zu-mp-note{line-height:1.6;color:var(--color-foreground-subtle,#a1a1a1);overflow-wrap:anywhere}" +
      /* v132 弹窗视格对齐宿主设置页（用户指令）：宿主令牌映射——容器=bg-input+border-input-border
       * rounded-lg、行=px-3 py-2+border-b 分隔、控件高 h-8、徽标=bg-surface+text-ui-xs/sm、
       * 正文=ui 字体（模型 id 才 mono），字号/间距全部跟随 --ui-font-size */
      ".zu-mp-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center}" +
      ".zu-mp-modal{position:relative;display:flex;flex-direction:column;gap:10px;width:min(520px,calc(100vw - 48px));max-height:76vh;" +
      "background:rgba(19,22,30,.97);background:color-mix(in srgb,var(--color-card,#13161e) 97%,transparent);" +
      "backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);" +
      "border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:12px;padding:16px;" +
      "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
      "font-size:var(--ui-font-size,14px);line-height:1.55;color:var(--color-foreground,#c6cdd9);" +
      "box-shadow:0 12px 32px rgba(0,0,0,.5)}" +
      ".zu-mp-head{display:flex;align-items:flex-start;gap:8px}" +
      ".zu-mp-title{flex:1;font-weight:600;color:var(--color-foreground,#eef2f8);font-size:calc(var(--ui-font-size,14px) + 1px);overflow-wrap:anywhere}" +
      ".zu-mp-head2{display:flex;align-items:center;gap:8px;padding-right:28px}" +
      ".zu-mp-close{position:absolute;top:12px;right:12px;background:none;border:none;color:var(--color-foreground-subtle,#8791a3);font-size:14px;line-height:1.4;cursor:pointer;padding:2px 6px}" +
      ".zu-mp-close:hover{color:var(--color-foreground,#fafafa)}" +
      ".zu-mp-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center}" +
      ".zu-mp-search{flex:1 1 160px;min-width:0;height:32px;background:var(--color-input,rgba(0,0,0,.3));border:1px solid var(--color-input-border,rgba(255,255,255,.14));color:var(--color-foreground,#e9edf4);border-radius:8px;padding:0 12px;font:inherit;outline:none;transition:border-color .15s}" +
      ".zu-mp-search::placeholder{color:var(--color-foreground-subtlest,#6b7484)}" +
      ".zu-mp-search:focus{border-color:var(--color-input-border-focused,var(--color-brand,#57c7ff))}" +
      ".zu-mp-quick{display:flex;gap:6px}" +
      ".zu-mp-quick button{font:inherit;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground,#e9edf4);background:var(--color-secondary,rgba(255,255,255,.08));border:1px solid transparent;border-radius:8px;padding:0 10px;height:28px;cursor:pointer;white-space:nowrap;transition:background-color .15s}" +
      ".zu-mp-quick button:hover{background:var(--color-secondary-hover,rgba(255,255,255,.14))}" +
      ".zu-mp-items{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;background:var(--color-input,rgba(0,0,0,.25));border:1px solid var(--color-input-border,rgba(255,255,255,.12));border-radius:8px;scrollbar-width:thin}" +
      ".zu-mp-item{display:flex;align-items:center;gap:8px;padding:8px 12px;margin:0;cursor:pointer}" +
      ".zu-mp-item:not(:last-child){border-bottom:1px solid var(--color-input-border,rgba(255,255,255,.08))}" +
      ".zu-mp-item:hover{background:var(--color-hover,rgba(255,255,255,.05))}" +
      ".zu-mp-item input[type=checkbox]{accent-color:var(--color-brand,#57c7ff);margin-top:0}" +
      ".zu-mp-id{flex:1;min-width:0;font-family:var(--font-mono,Consolas,Menlo,monospace);font-size:var(--ui-font-size,14px);color:var(--color-foreground,#e9edf4);overflow-wrap:anywhere}" +
      ".zu-mp-meta{flex:0 0 auto;display:inline-flex;align-items:center;height:20px;padding:0 6px;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:6px;background:var(--color-surface,rgba(255,255,255,.04));color:var(--color-foreground-subtle,#8791a3);font-family:var(--font-mono,Consolas,Menlo,monospace);font-size:calc(var(--ui-font-size,14px) - 2px);white-space:nowrap}" +
      ".zu-mp-badge{flex:0 0 auto;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:6px;font-size:calc(var(--ui-font-size,14px) - 3px);line-height:1;white-space:nowrap}" +
      ".zu-mp-badge.zu-mp-old{color:var(--color-foreground-subtle,#8791a3);border:1px solid var(--color-border,rgba(255,255,255,.12));background:var(--color-surface,rgba(255,255,255,.03))}" +
      ".zu-mp-badge.zu-mp-new{color:#34D399;border:1px solid rgba(52,211,153,.45);background:rgba(52,211,153,.08)}" +   /* v132 新模型=emerald（HHQ 同源），浅色组换 700 档 */
      ".zu-mp-bolt{width:18px;height:18px;flex:0 0 auto;color:#3B82F6}" +   /* 标题 ⚡（HHQ 同款蓝），浅色组换 600 档 */
      ".zu-mp-close-abs{position:absolute;top:12px;right:12px}" +
      ".zu-mp-host[aria-busy=true]{cursor:progress;opacity:.7}" +
      "@keyframes zumpspin{to{transform:rotate(360deg)}}" +
      ".zu-mp-host[aria-busy=true] svg{animation:zumpspin .9s linear infinite}" +
      ".zu-mp-err:empty{display:none}.zu-mp-err{color:var(--color-destructive,#d8482f);min-height:1.2em;overflow-wrap:anywhere;font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-mp-foot{display:flex;align-items:center;gap:10px;padding-top:2px}" +
      ".zu-mp-count{flex:1;color:var(--color-foreground-subtle,#8791a3);font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-mp-actions{display:flex;gap:8px}" +
      ".zu-mp-actions button{font:inherit;font-size:var(--ui-font-size,14px);color:var(--color-foreground,#e9edf4);background:var(--color-secondary,rgba(255,255,255,.08));border:1px solid transparent;border-radius:8px;height:32px;padding:0 10px;cursor:pointer;transition:background-color .15s}" +
      ".zu-mp-actions button:hover{background:var(--color-secondary-hover,rgba(255,255,255,.14))}" +
      /* 确认钮=宿主原生 default variant 令牌（bg-primary/text-primary-foreground/hover:/80，h-8 px-2.5） */
      ".zu-mp-actions .zu-mp-ok{color:var(--color-primary-foreground,#fff);background:var(--color-primary,#3B82F6);padding:0 10px}" +
      ".zu-mp-actions .zu-mp-ok:hover{background:color-mix(in srgb,var(--color-primary,#3B82F6) 80%,transparent)}" +
      ".zu-mp-actions button:disabled{opacity:.5;cursor:default}" +
      /* v132 浅色主题组：弹窗自带 .zu-light（openMpShell 按宿主 <html>.dark 同步，applyTheme 实时换装）——
       * 变量令牌随宿主翻转，此处只覆盖变量缺失的固定色 */
      ".zu-mp-ov.zu-light .zu-mp-modal{color:#1e293b;box-shadow:0 12px 32px rgba(0,0,0,.18)}" +
      ".zu-mp-ov.zu-light .zu-mp-title{color:#0f172a}" +
      ".zu-mp-ov.zu-light .zu-mp-sub,.zu-mp-ov.zu-light .zu-mp-count,.zu-mp-ov.zu-light .zu-mp-note{color:#64748b}" +
      ".zu-mp-ov.zu-light .zu-mp-search{background:#fff;border-color:#cbd5e1;color:#0f172a}" +
      ".zu-mp-ov.zu-light .zu-mp-search::placeholder{color:#94a3b8}" +
      ".zu-mp-ov.zu-light .zu-mp-quick button{color:#0f172a;background:#f1f5f9}" +
      ".zu-mp-ov.zu-light .zu-mp-quick button:hover{background:#e2e8f0}" +
      ".zu-mp-ov.zu-light .zu-mp-items{background:#fff;border-color:#e2e8f0}" +
      ".zu-mp-ov.zu-light .zu-mp-item:not(:last-child){border-bottom-color:#f1f5f9}" +
      ".zu-mp-ov.zu-light .zu-mp-item:hover{background:#f8fafc}" +
      ".zu-mp-ov.zu-light .zu-mp-id{color:#0f172a}" +
      ".zu-mp-ov.zu-light .zu-mp-meta{background:#f8fafc;border-color:#e2e8f0;color:#64748b}" +
      ".zu-mp-ov.zu-light .zu-mp-close{color:#64748b}.zu-mp-ov.zu-light .zu-mp-close:hover{color:#0f172a}" +
      ".zu-mp-ov.zu-light .zu-mp-badge.zu-mp-old{color:#94a3b8;border-color:#e2e8f0;background:#f1f5f9}" +
      ".zu-mp-ov.zu-light .zu-mp-badge.zu-mp-new{color:#059669;border-color:#6ee7b7;background:#ecfdf5}" +
      ".zu-mp-ov.zu-light .zu-mp-actions button{color:#0f172a;background:#f1f5f9}" +
      ".zu-mp-ov.zu-light .zu-mp-actions button:hover{background:#e2e8f0}" +
      ".zu-mp-ov.zu-light .zu-mp-bolt{color:#2563EB}" +
      /* 子代理运行中呼吸灯 */
      "@keyframes zupulse{0%,100%{opacity:1}50%{opacity:.2}}" +
      ".dot{animation:zupulse 1.6s ease-in-out infinite;font-size:var(--ui-font-size,14px);line-height:1}" +
      /* 面板（v80 起 fixed 挂 body）：原 absolute 挂 bar、bottom:calc(100%+10px) 向上展开，
       * 但 in-card 形态下条长在输入卡片（overflow-hidden）内部，面板会被卡片裁掉——
       * 照 .tip/.zusage-exc 的 body+fixed 模式迁移，left/top 由 position*Panel 每帧按条矩形写。 */
      ".panel{position:fixed;background:rgba(19,22,30,.97);" +
      "background:color-mix(in srgb,var(--color-card,#13161e) 96%,transparent);" +
      "backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);" +
      "border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:12px;padding:12px 14px;display:none;" +
      "flex-direction:column;gap:4px;" +
      "font-family:var(--font-mono,Consolas,Menlo,'Microsoft YaHei UI',monospace);" +
      "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.6;color:var(--color-foreground,#c6cdd9);" +
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 12px 32px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.35);" +
      "min-width:280px;max-width:480px;max-height:72vh;overflow:auto;white-space:normal;z-index:2147483647;" +
      "scrollbar-width:thin;scrollbar-color:var(--color-border,rgba(255,255,255,.14)) transparent}" +
      ".panel.open{display:flex}" +
      /* v259：宿主多视图顶部有 48px [app-region:drag] 标题栏拖拽条（app.asar 实证，新建任务页无条件）；
       * Electron 拖拽区按几何命中、穿透上层未显式标注 no-drag 的元素——面板 top:8px 时头部（✕ 关闭钮）
       * 正落在条内，真实点击被窗口拖拽吞掉（「点击关闭无效」）。与宿主自家浮层同款修法：
       * 浮层根显式 no-drag 把自身矩形从拖拽区减掉（面板/子代理浮层、tooltip、mp 与压缩全屏遮罩）。 */
      ".zusage-panel,.tip,.zu-mp-ov,.zu-compact-dlg{-webkit-app-region:no-drag}" +
      ".zu-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}" +
      ".panel::-webkit-scrollbar{width:8px}" +
      ".panel::-webkit-scrollbar-thumb{background:var(--color-border,rgba(255,255,255,.14));border-radius:999px}" +
      ".panel label{display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:5px 8px;margin:0 -8px;" +
      "border-radius:8px;transition:background-color .12s ease-out}" +
      ".panel input[type=text]{width:110px;background:var(--color-input,rgba(0,0,0,.3));border:1px solid var(--color-foreground-subtle,#8791a3);" +
      "color:var(--color-foreground,#e9edf4);border-radius:6px;padding:2px 7px;font:inherit;outline:none}" +
      ".panel input[type=text]:focus{border-color:var(--color-brand,#57c7ff);box-shadow:0 0 0 2px rgba(87,199,255,.15)}" +
      ".panel .hr{border-top:1px solid var(--color-border,rgba(255,255,255,.08));margin:5px 0}" +
      ".panel .cap{color:var(--color-foreground-subtlest,#6b7484);margin:4px 0 2px;font-size:calc(var(--ui-font-size,14px) - 2px);letter-spacing:.08em}" +
      ".panel .phead{font-weight:600;color:var(--color-foreground,#eef2f8);font-size:calc(var(--ui-font-size,14px) + 2px);margin-bottom:7px;display:flex;align-items:center;gap:8px}" +
      ".panel .pver{color:var(--color-brand,#57c7ff);font-weight:400;font-size:calc(var(--ui-font-size,14px) - 2px);background:rgba(87,199,255,.12);background:color-mix(in srgb,var(--color-brand,#57c7ff) 12%,transparent);border-radius:999px;padding:1px 8px}" +
      ".panel label em{font-style:normal;color:var(--color-foreground-subtle,#6f7989);display:block}" +
      ".panel input[type=checkbox]{accent-color:var(--color-brand,#57c7ff);margin-top:3px}" +
      ".panel .pnote{line-height:1.6;color:var(--color-foreground-subtle,#6f7989);margin-top:3px}" +
      ".panel .zu-update-actions{display:flex;gap:8px;margin:5px 0}" +
      ".panel .zu-update-actions button{font:inherit;color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 10px;cursor:pointer}" +
      ".panel .zu-update-actions button:disabled{opacity:.5;cursor:default}" +
      /* v172 重启按钮：待重启时高亮；二次确认待命中强调色 */
      ".panel .zu-update-actions button[data-update=relaunch].zu-rr-armed{border-color:#ff6b57;color:#ff6b57}" +
      /* v208 已更新待重启提示条：与红点/armed 按钮同色系淡底强调 */
      ".panel .zu-upd-banner{margin:2px 0 5px;padding:5px 9px;border:1px solid rgba(255,107,87,.45);border-radius:6px;background:rgba(255,107,87,.12);color:#ff6b57;font-weight:600}" +
      ".panel .zu-upd-banner[hidden]{display:none}" +
      ".panel .zu-update-status{overflow-wrap:anywhere;white-space:pre-line}" +
      /* 更新进度（v89）：下载条按字节，安装条按校验/安装/同步三段推进；宿主安装器没有
       * 字节进度，用扫光动画表示仍在活动。主进程未推送 progress（旧版 updater）时整块隐藏。 */
      ".panel .zu-update-progress{display:flex;flex-direction:column;gap:6px;margin:6px 0 2px}" +
      ".panel .zu-update-progress[hidden]{display:none}" +
      ".panel .zu-progress-row{display:flex;align-items:center;gap:8px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground-subtle,#6f7989)}" +
      ".panel .zu-progress-label{flex:0 0 2.5em}" +
      ".panel .zu-progress-track{flex:1;height:6px;border-radius:999px;background:var(--color-hover,rgba(255,255,255,.08));overflow:hidden}" +
      ".panel .zu-progress-fill{height:100%;width:0;border-radius:999px;background:var(--color-brand,#57c7ff);transition:width .2s ease}" +
      ".panel .zu-progress-fill.active{background-image:linear-gradient(90deg,transparent 0,rgba(255,255,255,.4) 50%,transparent 100%);background-size:48px 100%;background-repeat:no-repeat;animation:zuProgressSweep 1.1s linear infinite}" +
      ".panel .zu-progress-value{flex:0 0 auto;min-width:3em;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}" +
      "@keyframes zuProgressSweep{from{background-position:-48px 0}to{background-position:calc(100% + 48px) 0}}" +
      /* v202 更新日志卡片：与更新卡片同款圆角边框；正文随设置内容区滚动，卡内不再开滚动条 */
      ".zu-settings .zu-notes-card{margin-top:12px;padding:12px 14px}" +
      ".zu-settings .zu-notes-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".zu-settings .zu-notes-title{font-weight:600;color:var(--color-foreground,#eef2f8);font-size:calc(var(--ui-font-size,14px) + 1px)}" +
      ".zu-settings .zu-notes-badge{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-brand,#57c7ff);background:color-mix(in srgb,var(--color-brand,#57c7ff) 12%,transparent);border-radius:999px;padding:1px 8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-settings .zu-notes-badge.zu-notes-warn{color:#d97706;background:color-mix(in srgb,#d97706 12%,transparent)}" +
      ".zu-settings .zu-notes-history-btn{margin-left:auto;font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:2px 10px;cursor:pointer}" +
      ".zu-settings .zu-notes-meta{color:var(--color-foreground-subtle,#6f7989);font-size:calc(var(--ui-font-size,14px) - 2px);margin-top:3px;overflow-wrap:anywhere}" +
      ".zu-settings .zu-notes-body{margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground,#c6cdd9);line-height:1.65;overflow-wrap:anywhere;min-width:0}" +
      ".zu-settings .zu-notes-body p{margin:4px 0}" +
      ".zu-settings .zu-notes-body ul,.zu-settings .zu-notes-body ol{margin:4px 0;padding-left:1.5em}" +
      ".zu-settings .zu-notes-body blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid var(--color-border,rgba(255,255,255,.14));color:var(--color-foreground-subtle,#8d95a5)}" +
      ".zu-settings .zu-notes-body pre{background:var(--color-input,rgba(0,0,0,.25));border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:8px;padding:8px 10px;overflow-x:auto;font-family:var(--font-mono,Consolas,Menlo,'Microsoft YaHei UI',monospace);font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      ".zu-settings .zu-notes-body code{font-family:var(--font-mono,Consolas,Menlo,'Microsoft YaHei UI',monospace);font-size:calc(var(--ui-font-size,14px) - 2px);background:var(--color-hover,rgba(255,255,255,.08));border-radius:4px;padding:0 4px}" +
      ".zu-settings .zu-notes-body pre code{background:none;padding:0}" +
      ".zu-settings .zu-notes-body hr{border:0;border-top:1px solid var(--color-border,rgba(255,255,255,.12));margin:8px 0}" +
      ".zu-settings .zu-notes-h{font-weight:600;color:var(--color-foreground,#eef2f8);margin:10px 0 4px;line-height:1.4}" +
      ".zu-settings .zu-notes-h1{font-size:calc(var(--ui-font-size,14px) + 2px)}" +
      ".zu-settings .zu-notes-h2{font-size:calc(var(--ui-font-size,14px) + 1px)}" +
      ".zu-settings .zu-notes-h3{font-size:var(--ui-font-size,14px)}" +
      ".zu-settings .zu-notes-lnk{background:none;border:0;padding:0;font:inherit;color:var(--color-brand,#57c7ff);text-decoration:underline;cursor:pointer;overflow-wrap:anywhere;text-align:left}" +
      ".zu-settings .zu-notes-attn{border:1px solid color-mix(in srgb,#d97706 45%,transparent);background:color-mix(in srgb,#d97706 8%,transparent);border-radius:8px;padding:6px 10px;margin:6px 0}" +
      ".zu-settings .zu-notes-more{color:var(--color-foreground-subtle,#6f7989);font-size:calc(var(--ui-font-size,14px) - 2px);margin-top:4px}" +
      ".zu-settings .zu-notes-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px}" +
      ".zu-settings .zu-notes-foot button{font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 10px;cursor:pointer}" +
      ".zu-settings .zu-notes-foot button:disabled{opacity:.5;cursor:default}" +
      ".zu-settings .zu-notes-link{border-color:var(--color-brand,#57c7ff);color:var(--color-brand,#57c7ff);background:none}" +
      ".zu-settings .zu-notes-history{margin-top:8px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));padding-top:6px;display:flex;flex-direction:column;gap:2px}" +
      ".zu-settings .zu-notes-hist-item{display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;font:inherit;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground,#c6cdd9);background:none;border:0;border-radius:6px;padding:4px 6px;cursor:pointer}" +
      ".zu-settings .zu-notes-hist-item:hover{background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".zu-settings .zu-notes-hist-ver{flex:0 0 auto;font-family:var(--font-mono,Consolas,Menlo,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums}" +
      ".zu-settings .zu-notes-hist-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-foreground-subtle,#8d95a5)}" +
      ".zu-settings .zu-notes-hist-note{color:var(--color-foreground-subtle,#6f7989);font-size:calc(var(--ui-font-size,14px) - 2px);padding:2px 6px}" +
      ".panel.zu-settings{box-sizing:border-box;min-width:0;max-width:none;" +
      "max-height:min(90vh,var(--zu-settings-height,90vh));padding:0;gap:0;overflow:hidden;line-height:1.5}" +
      ".zu-settings .zu-settings-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;" +
      "padding:14px 16px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-settings .phead{margin:0;font-size:var(--ui-font-size,14px);font-weight:600}" +
      ".zu-settings .zu-settings-close{position:relative;background:none;border:0;font:inherit;color:var(--color-foreground-subtle,#8791a3);" +
      "padding:2px 6px;border-radius:6px;cursor:pointer}" +
      /* v223：命中区外扩——按钮本体仅约 20×24px，悬停点击常落在四周 head 空白上无反应
         （用户反馈「不灵敏」）；::after 外扩 6px 扩大命中与 hover 反馈，不改布局。 */
      ".zu-settings .zu-settings-close::after{content:\"\";position:absolute;inset:-6px;border-radius:9px}" +
      ".zu-settings .zu-settings-close:hover::after{background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".zu-settings .zu-settings-close:hover{background:var(--color-hover,rgba(255,255,255,.07))}" +
      /* 分区布局（v100）：左栏分组导航 + 右侧内容区（一次只显示一个分区），ZCode 设置页同款双栏 */
      ".zu-settings .zu-settings-layout{flex:1;min-height:0;display:flex}" +
      ".zu-settings .zu-settings-nav{flex:0 0 auto;width:164px;overflow-y:auto;padding:2px 8px 12px;scrollbar-width:thin;" +
      "scrollbar-color:var(--color-foreground-subtlest,#6b7484) transparent;border-right:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-settings .zu-settings-nav::-webkit-scrollbar{width:8px}" +
      ".zu-settings .zu-settings-nav::-webkit-scrollbar-thumb{background:var(--color-foreground-subtlest,#6b7484);border:2px solid transparent;background-clip:padding-box;border-radius:999px}" +
      ".zu-settings .zu-settings-navgroup+.zu-settings-navgroup{margin-top:16px}" +
      ".zu-settings .zu-navcap{padding:0 10px 5px;font-size:calc(var(--ui-font-size,14px) - 2px);font-weight:500;letter-spacing:0;" +
      "color:var(--color-remote-foreground-muted,#8d95a5)}" +
      /* 导航项：ZCode 侧栏同款 32px 行 + 12px 圆角 + surface-hover 激活底；图标恒为前景色 */
      ".zu-settings .zu-navitem{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:0;border-radius:12px;" +
      "background:none;font:inherit;font-size:var(--ui-font-size,14px);line-height:1.4;text-align:left;cursor:pointer;position:relative;" +
      "color:var(--color-remote-foreground-muted,#8d95a5);transition:background-color .12s ease-out,color .12s ease-out}" +
      /* v172 「插件更新」导航红点：与齿轮红点同待办、同 ack */
      ".zu-settings .zu-nav-dot{position:absolute;top:5px;right:7px;width:6px;height:6px;border-radius:50%;background:#ff6b57;display:none}" +
      ".zu-settings .zu-navitem:hover,.zu-settings .zu-navitem[aria-current]{background:var(--color-surface-hover,rgba(255,255,255,.08));color:var(--color-foreground,#e9edf4)}" +
      ".zu-settings .zu-navitem[aria-current]{box-shadow:none;font-weight:500}" +
      ".zu-settings .zu-navitem:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c8ff))!important;outline-offset:2px}" +
      ".zu-settings .zu-nav-ic{flex:0 0 16px;display:inline-flex;align-items:center;justify-content:center;color:var(--color-foreground,#e9edf4)}" +
      ".zu-settings .zu-nav-ic svg{width:16px;height:16px;display:block}" +
      ".zu-settings .zu-nav-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      /* 窄条收成 icon rail（ZCode max-lg icon-only 同语义；阈值由 syncSettingsScroll 按面板实测宽切换） */
      ".zu-settings.zu-nav-icons .zu-settings-nav{width:52px;padding:2px 6px 12px}" +
      ".zu-settings.zu-nav-icons .zu-navitem{justify-content:center;padding:0}" +
      ".zu-settings.zu-nav-icons .zu-nav-label,.zu-settings.zu-nav-icons .zu-navcap{" +
      "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}" +
      ".zu-settings .zu-settings-body{flex:1;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;" +
      "padding:16px clamp(16px,2vw,28px) 20px;scrollbar-width:thin;scrollbar-color:var(--color-foreground-subtlest,#6b7484) transparent}" +
      ".zu-settings .zu-settings-section{width:min(100%,960px);margin:0 auto}" +
      ".zu-settings .zu-settings-card{width:100%}" +
      ".zu-settings-body::-webkit-scrollbar{width:8px}" +
      ".zu-settings-body::-webkit-scrollbar-thumb{background:var(--color-foreground-subtlest,#6b7484);border:2px solid var(--color-card,#13161e);border-radius:999px}" +
      ".zu-settings.zu-settings-more .zu-settings-body{mask-image:linear-gradient(#000 calc(100% - 16px),transparent)}" +
      /* 分区标题（v100）：单分区视图下 cap 即该页标题，提级为前景色 + 略大字号 */
      ".zu-settings .cap{margin:0 0 8px;letter-spacing:0;color:var(--color-foreground,#e9edf4);font-weight:600;" +
      "font-size:calc(var(--ui-font-size,14px) + 1px)}" +
      ".zu-settings .zu-settings-card{border:1px solid var(--color-card-border,var(--color-border,rgba(255,255,255,.09)));border-radius:12px;" +
      "background:var(--color-card,var(--color-surface,rgba(255,255,255,.04)));overflow:hidden}" +
      ".zu-settings label{align-items:flex-start;gap:14px;margin:0;padding:12px 14px;border-radius:0}" +
      ".zu-settings label>span{padding-top:1px}" +
      ".zu-settings label>input{flex:0 0 auto;margin-top:4px}" +
      ".zu-settings label em{max-width:72ch}" +
      ".zu-settings .zu-settings-detail{max-width:88ch}" +
      ".zu-settings .zu-settings-card>label+label{border-top:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-settings label>span{flex:1;min-width:0;font-weight:500}" +
      ".zu-settings label em{font-weight:400;margin-top:2px;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.5}" +
      ".zu-settings input[type=checkbox]{appearance:none;-webkit-appearance:none;order:2;position:relative;flex:0 0 28px;" +
      "width:28px;height:16px;margin:0;border:1px solid var(--color-border,rgba(255,255,255,.18));border-radius:999px;" +
      "background:var(--color-input,rgba(255,255,255,.12));border-color:var(--color-foreground-subtle,#8791a3);cursor:pointer}" +
      ".zu-settings input[type=checkbox]::before{content:'';position:absolute;left:2px;top:2px;width:10px;height:10px;" +
      "border-radius:50%;background:var(--color-foreground-subtle,#8791a3)}" +
      ".zu-settings input[type=checkbox]:checked{background:var(--color-brand,#57c7ff);border-color:var(--color-brand,#57c7ff)}" +
      ".zu-settings input[type=checkbox]:checked::before{left:14px;background:var(--color-background,#13161e)}" +
      ".zu-settings input:focus-visible,.zu-settings button:focus-visible{outline:2px solid var(--color-input-border-focused,var(--color-brand,#57c7ff))!important;outline-offset:2px}" +
      ".zu-settings input:disabled{opacity:.4;cursor:default}" +
      ".zu-settings .zu-ctxov{order:2;box-sizing:border-box;width:120px;min-width:0;padding:5px 7px}" +
      ".zu-settings .zu-ac-value{order:2;box-sizing:border-box;width:120px;min-width:0;padding:5px 7px}" +
      ".zu-settings .zu-ac-status{font-size:12px;line-height:1.5;opacity:.75;white-space:pre-wrap;word-break:break-word;padding:2px 14px 8px}" +
      ".zu-settings .zu-ac-status.zu-ac-warn{opacity:1;color:#d97706}" +
      ".zu-settings .zu-settings-langs,.zu-settings .zu-theme-options{display:flex;gap:8px;padding:10px 12px}" +
      ".zu-settings .zu-settings-langs label,.zu-settings .zu-theme-options label{flex:1;display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px}" +
      ".zu-settings .zu-theme-title{padding:12px 14px 0;font-weight:500}" +
      ".zu-settings input[type=radio]{accent-color:var(--color-brand,#57c7ff);margin:0}" +
      ".zu-settings .zu-settings-detail{padding:0 12px 10px}" +
      ".zu-settings .zu-settings-card>.pnote{padding:2px 12px 4px}" +
      ".zu-settings .zu-settings-detail .pnote{font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      ".zu-settings .zu-settings-foot{flex:0 0 auto;display:flex;align-items:center;gap:10px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));padding:9px 12px}" +
      ".zu-settings .zu-settings-scroll{display:block;flex:1;min-width:0;width:auto;border:0;background:none;font:inherit;" +
      "font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-brand,#57c7ff);padding:2px;cursor:pointer}" +
      ".zu-settings .zu-settings-scroll:disabled{color:var(--color-foreground-subtle,#8791a3);cursor:default}" +
      /* 反馈按钮（v70）：常驻底栏右缘，点击经 window.open 交由系统默认浏览器打开 issues */
      ".zu-settings .zu-settings-feedback-status{flex:0 1 auto;min-width:0;color:var(--color-foreground-subtle,#a1a1a1);font-size:calc(var(--ui-font-size,14px) - 2px);overflow-wrap:anywhere}" +
      ".zu-settings .zu-settings-feedback{flex:0 0 auto;font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);" +
      "color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));" +
      "border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 10px;cursor:pointer}" +
      /* 子代理明细面板（v49）：点击条目弹出的固定面板（与设置面板同机制，互斥打开）；
       * 面板不随鼠标消失，绕开悬停+tab 的全部几何问题。 */
      ".zu-sub{cursor:pointer}" +
      ".zu-sub:hover .v{color:var(--color-foreground,#fff)}" +
      /* v217 子代理统一浮层（.zu-sub-pop）：悬停预览/点击固定共用同一双栏组件。
       * 外壳=标题栏 54px / 左导航 28% / 右内容 / 底部说明 42px；面板 .panel 基础
       * 之上覆写：清 padding/gap、限宽高、字体走 UI sans（数值列单独 mono）。 */
      ".panel.zu-sub-pop{width:820px;max-width:calc(100vw - 24px);height:auto;min-height:500px;max-height:calc(100vh - 24px);padding:0;gap:0;border-radius:14px;overflow:hidden;font-family:var(--font-sans,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:var(--ui-font-size,14px);line-height:1.55}" +
      ".zu-sph{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:54px;padding:0 18px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-sph-t{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:700;color:var(--color-foreground,#f1f2f3)}" +
      ".zu-sph-scope{margin-left:auto;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-foreground-subtle,#a8aaae);border:1px solid var(--color-border,rgba(255,255,255,.16));border-radius:999px;padding:2px 11px;white-space:nowrap}" +
      ".zu-sph-x{display:flex;align-items:center;justify-content:center;background:none;border:0;color:var(--color-foreground-subtle,#a8aaae);cursor:pointer;padding:5px;border-radius:7px}" +
      ".zu-sph-x:hover{color:var(--color-foreground,#f1f2f3);background:var(--color-hover,rgba(255,255,255,.08))}" +
      ".zu-spb{flex:1 1 auto;min-height:0;display:flex}" +
      ".zu-spnav{flex:0 0 28%;min-width:0;display:flex;flex-direction:column;background:rgba(0,0,0,.16);border-right:1px solid var(--color-border,rgba(255,255,255,.09));padding:10px 0 6px}" +
      ".zu-light .zu-spnav{background:rgba(0,0,0,.035)}" +
      ".zu-spnav-item{display:block;width:calc(100% - 16px);margin:1px 8px;padding:7px 10px 7px 11px;text-align:left;background:none;border:0;border-left:2px solid transparent;border-radius:0 8px 8px 0;color:var(--color-foreground-subtle,#a8aaae);font:inherit;font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.45;cursor:pointer}" +
      ".zu-spnav-item:hover{color:var(--color-foreground,#f1f2f3);background:var(--color-hover,rgba(255,255,255,.06))}" +
      ".zu-spnav-item.on{color:#b6a1f2;background:rgba(182,161,242,.14);border-left-color:#b6a1f2;font-weight:600}" +
      ".zu-light .zu-spnav-item.on{color:#6f54c8;background:rgba(111,84,200,.10);border-left-color:#6f54c8}" +
      ".zu-spnav-item:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:-2px}" +
      ".zu-spnav-label{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;word-break:break-word}" +
      ".zu-spnav-live{display:block;font-size:calc(var(--ui-font-size,14px) - 2px);font-weight:400;color:#3ecf8e;margin-top:1px}" +
      ".zu-light .zu-spnav-live{color:#0c8a63}" +
      ".zu-spnav-h{padding:9px 19px 3px;font-size:calc(var(--ui-font-size,14px) - 2px);letter-spacing:.06em;color:var(--color-foreground-subtlest,#6b7484)}" +
      ".zu-spnav-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding-bottom:4px}" +
      ".zu-spbody{flex:1 1 auto;min-width:0;overflow-y:auto;max-height:calc(100vh - 120px);padding:18px 20px}" +
      ".zu-spnav-list::-webkit-scrollbar,.zu-spbody::-webkit-scrollbar{width:8px}" +
      ".zu-spnav-list::-webkit-scrollbar-thumb,.zu-spbody::-webkit-scrollbar-thumb{background:var(--color-border,rgba(255,255,255,.14));border-radius:999px}" +
      ".zu-spview-head{display:flex;align-items:baseline;gap:12px;margin-bottom:13px}" +
      ".zu-spview-head h3{margin:0;font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:700;color:var(--color-foreground,#f1f2f3);min-width:0;overflow-wrap:anywhere}" +
      ".zu-spsub{color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 2px);white-space:nowrap;flex:0 0 auto}" +
      ".zu-spstate{margin-left:auto;display:flex;align-items:center;gap:7px;color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 2px);white-space:nowrap;flex:0 0 auto}" +
      ".zu-spstate .dot{width:7px;height:7px;border-radius:50%;background:var(--color-foreground-subtlest,#6b7484)}" +
      ".zu-spstate.run .dot{background:#3ecf8e}" +
      ".zu-light .zu-spstate.run .dot{background:#0c8a63}" +
      ".zu-sp-kpis3{display:grid;grid-template-columns:1fr 1fr 1fr;background:var(--color-surface,rgba(255,255,255,.035));border:1px solid var(--color-border,rgba(255,255,255,.07));border-radius:10px;padding:11px 0;margin-bottom:11px}" +
      ".zu-sp-kpi{min-width:0;padding:2px 18px}" +
      ".zu-sp-kpi + .zu-sp-kpi{border-left:1px solid var(--color-border,rgba(255,255,255,.08))}" +
      ".zu-sp-kpi .k{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-foreground-subtle,#a8aaae);margin-bottom:2px;display:flex;align-items:center;gap:5px}" +
      ".zu-sp-kpi .v{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 14px);font-weight:700;color:var(--color-foreground,#f1f2f3);line-height:1.3}" +
      ".zu-sp-kpi .v small{font-size:calc(var(--ui-font-size,14px) + 1px);font-weight:600;color:var(--color-foreground-subtle,#a8aaae);margin-left:4px}" +
      ".zu-sp-kpi .u{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-foreground-subtlest,#6b7484);margin-top:2px}" +
      ".zu-sp-kpi .u .hit{color:#4ade80;font-weight:600}" +
      ".zu-sp-usage{background:none;border:0;border-radius:0;padding:4px 0}" +
      ".zu-sp-usage .zu-sp-kpi:first-child{padding-left:2px}" +
      ".zu-sp-usage .zu-sp-kpi .v{font-size:calc(var(--ui-font-size,14px) + 8px)}" +
      ".zu-sp-rate{display:flex;align-items:baseline;gap:8px;padding:4px 2px 0;color:var(--color-foreground-subtle,#a8aaae)}" +
      ".zu-sp-rate b{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 2px);font-weight:700}" +
      ".zu-sp-models{margin-top:12px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));padding-top:12px}" +
      ".zu-sp-models h4{margin:0 0 9px;font-size:calc(var(--ui-font-size,14px) + 1px);font-weight:700;color:var(--color-foreground,#f1f2f3)}" +
      ".zu-sp-models table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}" +
      ".zu-sp-models thead th{background:none;text-align:right;font-weight:500;color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 1px);padding:0 10px 7px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.14));white-space:nowrap}" +
      ".zu-sp-models thead th:first-child{text-align:left;padding-left:2px}" +
      ".zu-sp-models td{padding:7px 10px;border-top:1px solid var(--color-border,rgba(255,255,255,.08));text-align:right;color:var(--color-foreground,#e6e9ef);font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-size:var(--ui-font-size,14px);white-space:nowrap}" +
      ".zu-sp-models tr:first-child td{border-top:0}" +
      ".zu-sp-models td:first-child{text-align:left;padding-left:2px;font-family:inherit;color:var(--color-foreground,#f1f2f3);white-space:normal;overflow-wrap:anywhere}" +
      ".zu-sp-meta{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline;margin-top:12px;padding-top:12px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-sp-meta b{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-weight:600;color:var(--color-foreground,#e6e9ef)}" +
      ".zu-spf{flex:0 0 auto;display:flex;align-items:center;gap:8px;height:42px;padding:0 18px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));color:var(--color-foreground-subtle,#a8aaae);font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      "@media (max-width:700px){.zu-spb{flex-direction:column}.zu-spnav{flex:0 0 auto;max-height:150px;border-right:0;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09))}.zu-spnav-list{overflow-y:auto}.zu-spbody{flex:1 1 auto}}" +
      /* 自绘 tooltip（v31）：向上弹出（原生 title 方向不可控且会被窗口下缘遮挡），
       * 支持多 tab；white-space:pre-line 保留数据里的 \n 换行。
       * v32：fixed 挂 body —— 原 absolute 挂 bar，被页面消息流的层叠上下文盖住
       * （diag 实证 disp=block 但不可见），挂 body 用视口坐标独立定位。
       * v81：底色/边框/文字改宿主 Radix Tooltip 同款（bg-tooltip + border-border +
       * text-tooltip-foreground，反色底：暗色主题白底黑字、浅色主题黑底白字），
       * 内部次级文字用宿主 tooltip-tag 系变量；毛玻璃在实色底下无意义，删。 */
      ".tip{position:fixed;background:var(--color-tooltip,#171717);" +
      "border:1px solid var(--color-popover-border,var(--color-border,transparent));border-radius:10px;padding:10px 13px;" +
      "font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);" +
      "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.55;color:var(--color-tooltip-foreground,#fafafa);" +
      "box-shadow:0 10px 28px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3);" +
      "white-space:pre-line;z-index:2147483646;width:max-content;max-width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;display:none;scrollbar-width:thin}" +
      /* 结构化 tooltip：标签次于标题，数值回到高对比前景；长说明自然折行。 */
      ".tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 8px}" +
      ".tip .rt-row{display:flex;gap:12px;margin:4px 0;align-items:flex-start}" +
      ".tip .rt-row b{flex:0 0 auto;min-width:86px;white-space:nowrap;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500}" +
      /* v164 模型名等长键不换行（键列随内容加宽）；rt-pin 吸底行遮住滚过的内容并分隔 */
      ".tip .rt-pin{position:sticky;bottom:0;z-index:1;background:var(--color-tooltip,#171717);margin-top:6px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent))}" +
      /* v165 模型明细表格化：整块共享最宽键列，token/次数列纵向对齐 */
      ".tip .rt-models{display:table;margin:5px 0 2px}" +
      ".tip .rt-models .rt-row{display:table-row;margin:0}" +
      ".tip .rt-models .rt-row b{display:table-cell;padding:2.5px 14px 2.5px 0;white-space:nowrap}" +
      ".tip .rt-models .rt-row span{display:table-cell;white-space:nowrap}" +
      /* v167 带 rt-models 的 tooltip（会话/项目累计）放宽宽度帽：取最宽一行自适应 */
      ".tip.zu-tip-wide{max-width:min(860px,calc(100vw - 24px))}" +
      ".tip .rt-tool{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:16px;margin:5px 0;align-items:baseline}.tip .rt-tool-name{overflow-wrap:anywhere}.tip .rt-tool>.rt-atom{text-align:right}" +
      ".tip .rt-atom{display:inline-block;white-space:nowrap}" +
      ".tip .rt-row span{min-width:0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:normal}" +
      ".tip .rt-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent));color:var(--color-tooltip-tag-foreground,#a6a6a6);overflow-wrap:anywhere}" +
      /* v127 颜色对照图例：档位类（.zu-teal 等）与条面同源，tip 内直接生效、随 .zu-light 切浅色 */
      ".tip .rt-legend{display:flex;flex-wrap:wrap;gap:3px 10px;margin-top:8px;padding-top:7px;" +
      "border-top:1px solid var(--color-popover-border,var(--color-border,transparent));font-weight:600}" +
      ".tip .rt-legend b{color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500;margin-right:2px}" +
      ".tip .rt-lsep{color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:400}" +
      ".ttabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px}" +
      ".ttab{font:inherit;border:0;text-align:left;cursor:pointer;padding:2px 10px;border-radius:999px;background:var(--color-tooltip-tag,#262626);" +
      "color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap;font-size:calc(var(--ui-font-size,14px) - 1px);" +
      "transition:background-color .12s ease-out,color .12s ease-out}" +
      ".ttab:hover{color:var(--color-tooltip-foreground,#fafafa);background:color-mix(in srgb,var(--color-tooltip-foreground,#fafafa) 12%,transparent)}" +
      ".ttab.on{background:color-mix(in srgb,var(--color-brand,#5ac8ff) 16%,transparent);color:var(--color-brand,#5ac8ff)}" +
      ".tbody{max-height:60vh;overflow:auto;scrollbar-width:thin;scrollbar-gutter:stable}" +
      /* v214 项目累计统计卡（作用域 .zu-project-tip；:has 定位本条，不动共享 .tip/.rt-* 规则）。
       * 字体分层：标题/标签/说明用宿主 sans 令牌，数值用 mono + tabular-nums（局部例外，
       * 其余 tooltip 仍统一 mono）。颜色全部沿用 tooltip 语义变量，浅色经 .zu-light 成套切换。 */
      ".zusage-tip-root:has(.zu-project-tip){max-width:min(840px,calc(100vw - 24px))}" +
      ".zusage-tip-root:has(.zu-project-tip) .tbody{padding:12px 15px}" +
      ".zu-project-tip{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--ui-font-size,14px) + 1px);line-height:1.5;color:var(--color-tooltip-foreground,#fafafa)}" +
      ".zu-pj-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:8px}" +
      ".zu-pj-title{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:700;letter-spacing:.5px}" +
      ".zu-pj-range{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-foreground,#fafafa);opacity:.72;border:1px solid var(--color-popover-border,rgba(255,255,255,.16));border-radius:999px;padding:2px 10px}" +
      ".zu-pj-scope{color:inherit}" +
      ".zu-pj-sub{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-pj-sub::before{content:'· ';opacity:.6}" +
      ".zu-pj-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:0 9px;background:rgba(255,255,255,.045);border-radius:8px;padding:7px 9px}" +
      ".zu-light .zu-pj-kpis{background:rgba(0,0,0,.045)}" +
      ".zu-pj-kpi{min-width:0}" +
      ".zu-pj-kpi + .zu-pj-kpi{border-left:1px solid var(--color-popover-border,rgba(255,255,255,.12));padding-left:9px}" +
      ".zu-light .zu-pj-kpi + .zu-pj-kpi{border-left-color:rgba(0,0,0,.12)}" +
      ".zu-pj-k{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);display:flex;align-items:center;gap:5px}" +
      ".zu-pj-v{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 15px);font-weight:700;margin-top:4px;white-space:nowrap}" +
      ".zu-pj-details{display:grid;grid-template-columns:repeat(3,1fr);gap:0 18px;margin-top:16px}" +
      ".zu-pj-detail .zu-pj-k{margin-bottom:2px}" +
      ".zu-pj-dv{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 7px);font-weight:600;white-space:nowrap}" +
      ".zu-pj-dsub{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-top:2px}" +
      ".zu-pj-hit{color:#4ade80;font-weight:600}" +
      ".zu-pj-scale{margin-top:14px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-tooltip-tag-foreground,#a6a6a6);display:flex;flex-wrap:wrap;column-gap:8px}" +
      /* v229：标题旁项目名，字号/颜色同规模行（.zu-pj-scale）；父级 .zu-pj-title 的 700/.5px 须显式还原。
         v230.1 垂直居中：标题容器带名称时切 flex（.zu-tt-name），名称为 flex 子项中心对齐——
         行内 baseline/bottom 对齐会被 18px 大字的 descent 拖得视觉偏低（用户实机指认） */
      ".zu-tt-name{display:flex;align-items:center}" +
      ".zu-pj-pname{font-size:calc(var(--ui-font-size,14px) - 1px);font-weight:400;letter-spacing:normal;color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-left:8px}" +
      ".zu-pj-mhead{display:flex;align-items:baseline;justify-content:space-between;margin:9px 0 4px}" +
      ".zu-pj-mtitle{font-size:calc(var(--ui-font-size,14px) + 2px);font-weight:700}" +
      ".zu-pj-morder{display:none}" +
      ".zu-pj-table{width:100%;border-collapse:collapse;font-size:var(--ui-font-size,14px)}" +
      ".zu-pj-table th{font-weight:500;color:var(--color-tooltip-tag-foreground,#a6a6a6);text-align:right;padding:0 10px 7px;border-bottom:1px solid var(--color-popover-border,rgba(255,255,255,.14));white-space:nowrap}" +
      ".zu-light .zu-pj-table th{border-bottom-color:rgba(0,0,0,.14)}" +
      ".zu-pj-table th:first-child{text-align:left;padding-left:2px}" +
      ".zu-pj-table td{padding:7px 10px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.08));height:32px;box-sizing:border-box;text-align:right;font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".zu-light .zu-pj-table td{border-top-color:rgba(0,0,0,.08)}" +
      ".zu-pj-table tr:first-child td{border-top:0}" +
      ".zu-pj-table td:first-child{text-align:left;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);padding-left:2px;max-width:300px;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-pj-more{display:block;margin:10px auto 0;background:none;border:0;color:var(--color-brand,#a3cfff);font:inherit;font-size:var(--ui-font-size,14px);cursor:pointer;padding:4px 12px;border-radius:8px}" +
      ".zu-pj-more:hover{text-decoration:underline}" +
      ".zu-pj-time{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:7px;padding-top:6px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12));font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-light .zu-pj-time{border-top-color:rgba(0,0,0,.12)}" +
      ".zu-pj-time b{font-weight:500}" +
      ".zu-pj-time span{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums}" +
      /* v215 六统计卡（生成速度/本轮/会话累计/工具调用/今日合计/子代理）：作用域
       * .zu-stat-tip + 类型修饰；:has 定位本条，不动共享 .tip/.rt-* 规则；字体分层同项目卡。 */
      ".zusage-tip-root:has(.zu-stat-tip){max-width:min(840px,calc(100vw - 24px))}" +
      ".zusage-tip-root:has(.zu-stat-tip) .tbody{padding:12px 15px}" +
      ".zu-stat-tip{font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:calc(var(--ui-font-size,14px) + 1px);line-height:1.5;color:var(--color-tooltip-foreground,#fafafa)}" +
      ".zu-stat-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:8px}" +
      ".zu-stat-title{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:700;letter-spacing:.5px}" +
      ".zu-stat-scope{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-foreground,#fafafa);opacity:.72;border:1px solid var(--color-popover-border,rgba(255,255,255,.16));border-radius:999px;padding:2px 10px;white-space:nowrap}" +
      ".zu-light .zu-stat-scope{border-color:rgba(0,0,0,.2)}" +
      ".zu-stat-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:0 9px;background:rgba(255,255,255,.045);border-radius:8px;padding:7px 9px}" +
      ".zu-light .zu-stat-kpis{background:rgba(0,0,0,.045)}" +
      ".zu-stat-kpis.cols2{grid-template-columns:repeat(2,1fr)}" +
      ".zu-stat-kpis.zu-stat-kpis--sub{background:rgba(255,255,255,.025);padding:6px 9px;margin-top:16px}" +
      ".zu-light .zu-stat-kpis.zu-stat-kpis--sub{background:rgba(0,0,0,.025)}" +
      ".zu-stat-kpis.zu-stat-kpis--sub .zu-stat-v{font-size:calc(var(--ui-font-size,14px) + 7px);font-weight:600}" +
      ".zu-stat-kpis.zu-stat-kpis4{grid-template-columns:repeat(4,1fr);gap:0 8px}" +
      ".zu-stat-kpis.zu-stat-kpis4 .zu-stat-kpi + .zu-stat-kpi{padding-left:8px}" +
      ".zu-stat-kpis.zu-stat-kpis4 .zu-stat-v{font-size:calc(var(--ui-font-size,14px) + 4px);white-space:normal;overflow-wrap:break-word}" +
      ".zu-stat-kpis.zu-stat-kpis4 .zu-stat-v small{display:block;font-size:calc(var(--ui-font-size,14px) - 2px);margin-top:1px}" +
      ".zu-stat-kpi{min-width:0}" +
      ".zu-stat-kpi + .zu-stat-kpi{border-left:1px solid var(--color-popover-border,rgba(255,255,255,.12));padding-left:9px}" +
      ".zu-light .zu-stat-kpi + .zu-stat-kpi{border-left-color:rgba(0,0,0,.12)}" +
      ".zu-stat-k{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);display:flex;align-items:center;gap:5px}" +
      ".zu-stat-v{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 15px);font-weight:700;margin-top:4px;white-space:nowrap}" +
      ".zu-stat-v small{font-size:calc(var(--ui-font-size,14px) + 2px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-stat-v.err,.zu-stat-kpi.err .zu-stat-v{color:#ff6b57}" +
      ".zu-light .zu-stat-v.err,.zu-light .zu-stat-kpi.err .zu-stat-v{color:#d8482f}" +
      ".zu-stat-grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:0 9px;margin-top:8px}" +
      ".zu-stat-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:0 18px;margin-top:12px}" +
      ".zu-stat-dv{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 7px);font-weight:600;white-space:nowrap;margin-top:2px}" +
      ".zu-stat-dsub{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-top:2px}" +
      ".zu-stat-dsub .hit{color:#4ade80;font-weight:600}" +
      ".zu-stat-scale{margin-top:7px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-tooltip-tag-foreground,#a6a6a6);display:flex;flex-wrap:wrap;column-gap:8px}" +
      /* v230：会话累计标题旁会话名，字号/颜色同规模行（.zu-stat-scale）；v230.1 垂直居中走
         .zu-tt-name 容器 flex；ellipsis 仍需块级盒（flex 子项自动块化，省略号成立） */
      ".zu-st-name{font-size:calc(var(--ui-font-size,14px) - 1px);font-weight:400;letter-spacing:normal;color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-left:8px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-stat-note{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-top:6px}" +
      ".zu-stat-time .zu-stat-note{flex:0 0 100%;margin-top:4px}" +
      ".zu-stat-time{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:14px;padding-top:12px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12));font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-light .zu-stat-time{border-top-color:rgba(0,0,0,.12)}" +
      ".zu-stat-time b{font-weight:500}" +
      ".zu-stat-time span{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums}" +
      ".zu-stat-table{width:100%;border-collapse:collapse;font-size:var(--ui-font-size,14px)}" +
      ".zu-stat-table th{font-weight:500;color:var(--color-tooltip-tag-foreground,#a6a6a6);text-align:right;padding:0 10px 7px;border-bottom:1px solid var(--color-popover-border,rgba(255,255,255,.14));white-space:nowrap}" +
      ".zu-light .zu-stat-table th{border-bottom-color:rgba(0,0,0,.14)}" +
      ".zu-stat-table th:first-child{text-align:left;padding-left:2px}" +
      ".zu-stat-table td{padding:7px 10px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.08));height:32px;box-sizing:border-box;text-align:right;font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".zu-light .zu-stat-table td{border-top-color:rgba(0,0,0,.08)}" +
      ".zu-stat-table tr:first-child td{border-top:0}" +
      ".zu-stat-table td:first-child{text-align:left;font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);padding-left:2px;max-width:300px;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-stat-table td.err{color:#ff6b57;font-weight:600}" +
      ".zu-light .zu-stat-table td.err{color:#d8482f}" +
      ".zu-stat-table td.dim0{color:var(--color-tooltip-tag-foreground,#a6a6a6);opacity:.7}" +
      ".zu-stat-more{display:block;margin:10px auto 0;background:none;border:0;color:var(--color-brand,#a3cfff);font:inherit;font-size:var(--ui-font-size,14px);cursor:pointer;padding:4px 12px;border-radius:8px}" +
      ".zu-stat-more:hover{text-decoration:underline}" +
      ".zu-speed-hero:has(.zu-sl-body){grid-template-columns:1fr}" +
      ".zu-speed-hero{display:grid;grid-template-columns:1fr 1fr;gap:0 9px;background:rgba(255,255,255,.045);border-radius:8px;padding:8px 9px}" +
      ".zu-light .zu-speed-hero{background:rgba(0,0,0,.045)}" +
      ".zu-speed-hero .zu-stat-kpi + .zu-stat-kpi{border-left:1px solid var(--color-popover-border,rgba(255,255,255,.12));padding-left:9px}" +
      ".zu-light .zu-speed-hero .zu-stat-kpi + .zu-stat-kpi{border-left-color:rgba(0,0,0,.12)}" +
      ".zu-speed-main{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 22px);font-weight:700;line-height:1.15;margin-top:4px;white-space:nowrap}" +
      ".zu-speed-main small{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-speed-sub{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 11px);font-weight:700;margin-top:4px;white-space:nowrap}" +
      ".zu-speed-sub small{font-size:calc(var(--ui-font-size,14px) - 1px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-speed-bandtag{display:inline-block;margin-top:8px;font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-size:calc(var(--ui-font-size,14px) - 1px);border:1px solid var(--color-popover-border,rgba(255,255,255,.16));border-radius:999px;padding:2px 10px}" +
      ".zu-legend-head{display:flex;align-items:baseline;justify-content:space-between;margin:18px 0 8px}" +
      ".zu-legend-title{font-size:calc(var(--ui-font-size,14px) + 2px);font-weight:700}" +
      ".zu-legend-unit{font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-legend-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px 10px}" +
      "@media (max-width:760px){.zusage-tip-root:has(.zu-stat-tip) .zu-legend-grid{grid-template-columns:repeat(3,1fr)}}" +
      ".zu-legend-item{display:flex;align-items:center;gap:7px;min-width:0;padding:3px 6px;border-radius:8px;border:1px solid transparent}" +
      ".zu-legend-item.cur{border-color:var(--color-popover-border,rgba(255,255,255,.35));background:rgba(255,255,255,.05)}" +
      ".zu-light .zu-legend-item.cur{background:rgba(0,0,0,.05)}" +
      ".zu-legend-dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%}" +
      ".zu-legend-item b{font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-weight:600;font-size:calc(var(--ui-font-size,14px) - 1px);white-space:nowrap}" +
      ".zu-legend-item .dot-c{background:currentColor}" +
      ".zu-legend-dot.zu-ultra{display:none;background:linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%)}" +
      ".zu-legend-dot.zu-ultra::before{content:none}" +
      /* v246 用户规格：图例 Ultra 档只留文字，色点整体隐藏；渐变/clip 规则保留供恢复 */
      /* ---------- v254 速度 Tooltip 重构样式（仅 .zu-sv-root 作用域，不碰旧图） ---------- */
      ".zu-sv-root{display:flex;flex-direction:column;gap:0}" +
      ".zu-sv-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}" +
      ".zu-sv-title{font-weight:700;font-size:calc(var(--ui-font-size,14px) + 6px);letter-spacing:.2px}" +
      ".zu-sv-range{display:flex;align-items:center;gap:5px;flex:0 0 auto;max-width:60%;padding:4px 10px;border-radius:999px;" +
        "background:rgba(255,255,255,.05);border:1px solid var(--color-popover-border,rgba(255,255,255,.14));" +
        "font-family:var(--font-mono,Consolas,Menlo,monospace);font-variant-numeric:tabular-nums;" +
        "font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-light .zu-sv-range{background:rgba(0,0,0,.05)}" +
      ".zu-sv-range svg{width:14px;height:14px;flex:0 0 auto;opacity:.8}" +
      ".zu-sv-range span{overflow:hidden;text-overflow:ellipsis}" +
      ".zu-sv-filter{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:8px}" +
      ".zu-sv-flabel{font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);flex:0 0 auto}" +
      ".zu-sv-time{display:flex;align-items:center;gap:6px;margin-left:auto}" +
      ".zu-sv-tabs{display:flex;flex:0 1 auto;flex-wrap:wrap;gap:2px;padding:2px;border-radius:9px;" +
        "background:rgba(255,255,255,.045);border:1px solid var(--color-popover-border,rgba(255,255,255,.1))}" +
      ".zu-light .zu-sv-tabs{background:rgba(0,0,0,.04)}" +
      ".zu-sv-tab{appearance:none;border:0;background:transparent;color:var(--color-tooltip-tag-foreground,#a6a6a6);" +
        "font-family:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.4;font-weight:600;padding:6px 10px;border-radius:7px;cursor:pointer;white-space:nowrap}" +
      ".zu-sv-tab:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv-tab:hover{background:rgba(0,0,0,.05)}" +
      /* v263：选中态改柔和强调（宿主 --color-brand 在当前主题解析为近白，直接当底色
       * 会出大面积纯白块——固定强调色深浅主题都可预期）；字重恒 600 防选中加粗跳动。 */
      ".zu-sv-tab.on{background:rgba(87,200,255,.14);color:#7fd4ff}" +
      ".zu-light .zu-sv-tab.on{background:rgba(87,200,255,.16);color:#0b6aa8}" +
      ".zu-sv-tab:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv-notice{flex:0 0 100%;font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-top:2px}" +
      /* v274：左卡按内容自然高，不再强制撑满图表高度（§11.2） */
      ".zu-sv-root .zu-speed-body{gap:12px;align-items:flex-start}" +
      ".zu-sv-root .zu-sv-left{flex:0 0 236px;gap:0}" +
      ".zu-sv-root .zu-sv-left .zu-sl-main{font-size:calc(var(--ui-font-size,14px) + 22px)}" +
      /* v263：左卡标题降为弱化说明（规格「历史统计 · 不含进行中请求」），.zu-sl-title
       * 是旧卡八态共用类，只在本卡作用域覆写 */
      ".zu-sv-root .zu-sl-title{font-weight:400;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv-root .zu-sl-sub{margin-left:6px;font-weight:400;font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);opacity:.85}" +
      ".zu-sv-root .zu-sv-left .zu-sl-body{justify-content:center}" +
      ".zu-sv-chart .zu-sc-head{margin-left:30px}" +
      ".zu-sv-chart .zu-sc-unit{margin-left:6px}" +
      ".zu-sv-plot{position:relative;height:176px;margin-left:30px;min-width:calc(100% - 30px);width:max-content;max-width:none;box-sizing:content-box}" +
      ".zu-sv-spacer{display:block;height:0}" +
      ".zu-sc-cov{font-size:calc(var(--ui-font-size,14px) - 4px);color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap}" +
      ".zu-sv-focus{appearance:none;border:1px solid var(--color-popover-border,rgba(255,255,255,.16));background:transparent;color:var(--color-tooltip-tag-foreground,#a6a6a6);" +
        "font-family:inherit;font-size:calc(var(--ui-font-size,14px) - 4px);line-height:1.3;padding:2px 8px;border-radius:6px;cursor:pointer;white-space:nowrap}" +
      ".zu-sv-focus:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv-focus:hover{background:rgba(0,0,0,.05)}" +
      ".zu-sv-focus:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv-plot .zu-sc-grid{height:148px}" +
      ".zu-sv-plot .zu-sc-gutter{height:148px}" +
      ".zu-sv-bars{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;gap:0}" +
      /* 细柱定宽：少量柱不拉伸、数据多时横滚，柱组居中 */
      ".zu-sv-bars .zu-sc-col{flex:0 0 30px;height:176px}" +
      ".zu-sv-bars .zu-sc-vz{height:148px;flex:0 0 148px}" +
      ".zu-sv-bars .zu-sc-bar{width:14px;max-width:14px}" +
      ".zu-sv-bars .zu-sc-x{height:28px;flex:0 0 28px;width:30px;max-width:30px;overflow:hidden;" +
        "justify-content:flex-start;align-items:flex-start;font-size:9px}" +
      ".zu-sv-bars .zu-sc-x b{display:block;width:100%;overflow:hidden;text-overflow:clip;text-align:center}" +
      ".zu-sv-bars .zu-sc-col.empty .zu-sc-bar{background:transparent;box-shadow:none}" +
      ".zu-sv-bars .zu-sc-col.cur .zu-sc-val{font-weight:700}" +
      ".zu-sv-chart .zu-sc-wrap{overflow-x:auto;overflow-y:hidden}" +
      ".zu-sv-plot{min-width:300px}" +
      /* hover 五字段信息卡：默认柱上方，右缘钳边，切柱随整卡重建不闪烁 */
      ".zu-sv-card-anchor{position:absolute;top:0;z-index:3;pointer-events:none}" +
      ".zu-sv-card{position:relative;top:2px;width:252px;box-sizing:border-box;" +
        "background:var(--color-popover,#1c212b);border:1px solid var(--color-popover-border,rgba(255,255,255,.18));" +
        "border-radius:9px;padding:7px 10px;box-shadow:0 8px 22px rgba(0,0,0,.42);display:flex;flex-direction:column;gap:3px}" +
      ".zu-light .zu-sv-card{box-shadow:0 8px 22px rgba(15,23,42,.18)}" +
      ".zu-sv-crow{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:10px;line-height:1.35}" +
      ".zu-sv-crow>span{flex:0 0 auto;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv-crow>b{min-width:0;text-align:right;font-family:var(--font-mono,Consolas,Menlo,monospace);font-variant-numeric:tabular-nums;" +
        "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-foreground,#e9edf4)}" +
      ".zu-sv-crow>b small{display:block;font-size:9px;font-weight:400;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv-crow>b.zu-sv-twrap{white-space:normal;word-break:break-all;line-height:1.35;text-align:right}" +
      ".zu-sl-stats.zu-sl-solo{opacity:.55}" +
      ".zu-sv-cval{font-size:12px!important;font-weight:700!important}" +
      ".zu-sv-off{opacity:.75}" +
      ".zu-sv-partial{font-style:normal;font-weight:400;opacity:.75;margin-left:3px}" +
      ".zu-sv-empty{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px 8px;height:176px;color:var(--color-tooltip-tag-foreground,#a6a6a6);" +
        "font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-sv-empty-hint{font-size:calc(var(--ui-font-size,14px) - 3px);opacity:.8}" +
      ".zu-sv-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px var(--color-popover-border,rgba(255,255,255,.28))}" +
      ".zu-light .zu-sv-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px rgba(15,23,42,.22)}" +
      /* 底部单行十档对照：当前档轻描边，窄窗自动换行不溢出 */
      ".zu-sv-legend{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding-top:8px;" +
        "border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12))}" +
      ".zu-sv-legend-t{flex:0 0 auto;font-size:calc(var(--ui-font-size,14px) - 2px);font-weight:600;white-space:nowrap;cursor:help}" +
      ".zu-sv-legend-items{display:flex;flex:1 1 auto;flex-wrap:wrap;gap:3px 5px;justify-content:flex-end}" +
      ".zu-sv-li{display:flex;align-items:center;gap:3px;padding:1px 4px;border-radius:7px;border:1px solid transparent}" +
      ".zu-sv-li.cur{border-color:var(--color-popover-border,rgba(255,255,255,.35));background:rgba(255,255,255,.05)}" +
      ".zu-light .zu-sv-li.cur{background:rgba(0,0,0,.05)}" +
      ".zu-sv-li b{font-family:var(--font-mono,Consolas,Menlo,monospace);font-variant-numeric:tabular-nums;" +
        "font-weight:600;font-size:calc(var(--ui-font-size,14px) - 3px);white-space:nowrap}" +
      "@media (max-width:780px){.zu-sv-root .zu-sv-left{flex:0 0 190px}.zu-sv-legend-items{justify-content:flex-start}}" +
      /* v232 速度柱状图：左读数卡 + 右「最近 10 段」图表。柱体颜色走档位类 currentColor
       * （与图例色点同套路），其余配色全走语义令牌（浅色自动适配）；plot min-width +
       * 横滚保证窄窗口下柱顶读数永不挤压重叠。 */
      ".zu-speed-body{display:flex;gap:10px;align-items:stretch}" +
      /* v242:合并 v232 基座与 v239 边框规则;border-box 下 250px=外观盒(内容 220),padding 12 让左卡总高贴近图表列 ~217px */
      ".zu-speed-left{flex:0 0 250px;min-width:0;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-start;background:rgba(255,255,255,.045);border:1px solid var(--color-popover-border,rgba(255,255,255,.12));border-radius:12px;padding:12px;overflow:hidden}" +
      ".zu-light .zu-speed-left{background:rgba(0,0,0,.045)}" +
      /* v233 主读数估宽分级：fit2 中长状态词缩号并允许换行；fit3 更长再缩 + break-word。
       * 只挂左卡作用域，legacy hero（无图表旧快照）维持原 nowrap 大字不动。 */
      ".zu-speed-left .zu-speed-fit2{font-size:calc(var(--ui-font-size,14px) + 10px);white-space:normal;line-height:1.25}" +
      /* v235 结构化左卡分层节点：状态标题/名称/主数值/单位/辅助说明各自独立，
       * 数值型走档位色（st.band），工具/Skill/思考/子代理保持中性 dim 语义 */
      ".zu-sl-status{display:flex;align-items:center;gap:6px;font-size:calc(var(--ui-font-size,14px) - 1px);color:var(--color-foreground-subtle,#8791a3);min-width:0}" +
      ".zu-sl-status .ico{width:20px;height:20px;flex:0 0 auto}" +
      ".zu-sl-count{flex:0 0 auto;font-size:calc(var(--ui-font-size,14px) - 4px);font-weight:700;line-height:1.5;border:1px solid currentColor;border-radius:999px;padding:0 6px}" +
      ".zu-sl-main{margin-top:8px;font-family:var(--font-mono,Consolas,'Cascadia Mono',Menlo,'Microsoft YaHei UI',monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 22px);font-weight:700;line-height:1.1;white-space:nowrap}" +
      ".zu-sl-unit{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-left:4px}" +
      ".zu-sl-val.dim,.zu-sl-estdim{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sl-note{margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-speed-left .zu-speed-fit3{font-size:calc(var(--ui-font-size,14px) - 1px);white-space:normal;line-height:1.3;word-break:break-word}" +
      ".zu-speed-note{margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-speed-left .zu-speed-bandtag{font-size:calc(var(--ui-font-size,14px) - 3px);padding:2px 8px;white-space:nowrap}" +
      ".zu-speed-chart{flex:1 1 auto;min-width:0;position:relative}" +
      /* v239（设计图复刻）：左卡深色玻璃卡 + 状态图标/当前读数标签；信息卡虚线引线；图例/口径行布局 */
      ".zu-sl-stats{padding-top:10px;display:flex;gap:6px;border-top:1px solid var(--color-border,rgba(255,255,255,.1))}" +
      ".zu-sl-stat{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px}" +
      ".zu-sl-stat i{font-style:normal;font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sl-stat b{font-family:var(--font-mono,Consolas,Menlo,monospace);font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) + 1px);font-weight:700}" +
      ".zu-sl-status span{min-width:0}" +
      /* v241：标题 15px 加粗；Skill 长名两行省略；主体区在剩余高度内垂直居中（填空旷），前缀「估/均」小号灰字 */
      /* v242:标题色不设 color——无档态继承 .zu-sl-status 中性灰,数值态由档位类直接着色(ultra 走渐变字) */
      ".zu-sl-title{font-weight:600;font-size:calc(var(--ui-font-size,14px) + 1px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-sl-status--wrap .zu-sl-title{font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.3;overflow-wrap:anywhere;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
      ".zu-sl-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:center;align-items:flex-start}" +
      ".zu-sl-body .zu-sl-main{margin-top:0}" +
      ".zu-sl-pre{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:600;color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-right:6px}" +
            ".zu-sl-k{margin-top:4px;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sc-lead{position:absolute;width:0;border-left:1px dashed currentColor;opacity:.7;pointer-events:none;transform:translateX(-.5px)}" +
      ".zu-legend-row{display:flex;align-items:center;gap:12px;margin:14px 0 4px;padding-top:10px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12))}" +
      ".zu-legend-row .zu-legend-title{flex:0 0 auto}" +
      ".zu-legend-grid.zu-legend-inline{display:flex;flex-wrap:wrap;flex:1 1 auto;justify-content:flex-start;gap:4px 4px}" +
      ".zu-legend-inline .zu-legend-item{gap:4px;padding:2px 4px}" +
      ".zu-legend-inline .zu-legend-item b{font-size:calc(var(--ui-font-size,14px) - 2px);letter-spacing:-.25px}" +
      ".zu-basis{display:flex;align-items:flex-start;gap:16px;margin-top:8px;padding-top:10px;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12))}" +
      ".zu-basis .zu-legend-title{flex:0 0 auto}" +
      ".zu-basis-v{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;gap:4px 0;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-basis-v>span+span{margin-left:12px;padding-left:12px;border-left:1px solid var(--color-popover-border,rgba(255,255,255,.16))}" +
      ".zu-basis-v .zu-pj-time{flex:0 0 100%;margin-top:4px;padding-top:0;border-top:0}" +
      ".zu-sc-head{display:flex;align-items:baseline;gap:8px;margin:0 0 6px 30px}" +
      ".zu-sc-title{font-weight:700;font-size:calc(var(--ui-font-size,14px) + 1px);white-space:nowrap}" +
      ".zu-sc-sub{color:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:calc(var(--ui-font-size,14px) - 3px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-sc-unit{margin-left:auto;flex:0 0 auto;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:calc(var(--ui-font-size,14px) - 3px)}" +
      ".zu-sc-wrap{overflow-x:auto;overflow-y:hidden}" +
      ".zu-sc-wrap::-webkit-scrollbar{height:8px}" +
      ".zu-sc-wrap::-webkit-scrollbar-thumb{background:var(--color-border,rgba(255,255,255,.14));border-radius:999px}" +
      /* v236：非 wide 图表不设 min-width——随容器压缩、靠稀疏时间标签兜底，任何窗口
       * 宽度都不出横向滚动条（用户规格）；wide（≥1000 t/s 读数 6 字符）保留横滚 */
      /* plot 高 = 160 柱区 + 29 X 轴（v237：border-box 下 X 行须 29px 才装得下两行时间，
       * 否则第二行被 wrap 的 overflow-y:hidden 裁半）；柱区/网格/沟槽顶锚 160px——列内容
       * 恰好填满 189，任何 flex-shrink 都会把柱区压短、柱体悬空离基线（实测教训），vz 显式 shrink:0 */
      /* v240/v242：帽 860（chart≈560）满宽无横滚；plot min-width 340 仅窄窗兜底——pitch<44
       * 阈值时公式会隔列显标签;wide(≥1000 t/s)加宽 420 横滚,读数 6 字符不挤压 */
      ".zu-sc-plot{position:relative;height:189px;margin-left:30px;min-width:340px}" +
      /* v242:wide(≥1000 t/s 读数 6 字符)横滚兜底加宽——340 下 pitch 34 时相邻读数间隙仅 1-3px */
      ".zu-sc-wrap.wide .zu-sc-plot{min-width:420px}" +
      ".zu-sc-grid{position:absolute;top:0;left:0;right:0;height:160px}" +
      ".zu-sc-grid i{position:absolute;left:0;right:0;border-top:1px dashed var(--color-border,rgba(255,255,255,.1))}" +
      ".zu-sc-grid i[data-base]{border-top:1px solid var(--color-border,rgba(255,255,255,.16))}" +
      ".zu-sc-gutter{position:absolute;left:-30px;top:0;height:160px;width:26px}" +
      ".zu-sc-gutter i{position:absolute;right:5px;transform:translateY(50%);font-style:normal;font-variant-numeric:tabular-nums;font-size:10px;line-height:1;color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap}" +
      ".zu-sc-gutter i.top{transform:none}" +
      /* bars 容器占满 plot 189（列内容 vz160+x29 恰好填满、零压缩），
       * grid/gutter 才是顶锚 160 的柱区——两者高度角色不能对调 */
      ".zu-sc-bars{position:absolute;inset:0;display:flex;align-items:stretch}" +
      /* 列内盒全部 border-box + 固定 flex-basis：160+24 恰好 184、零 flex-shrink——
       * content-box 下溢出的分数压缩会在各列产生 ±2px 取整差（柱底不齐，实测） */
      ".zu-sc-col,.zu-sc-col *{box-sizing:border-box}" +
      ".zu-sc-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;outline:none}" +
      ".zu-sc-vz{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;width:100%;height:160px;flex:0 0 160px}" +
      ".zu-sc-val{font-variant-numeric:tabular-nums;font-size:10px;line-height:1.2;letter-spacing:-.1px;color:var(--color-foreground,#e9edf4);margin-bottom:4px;white-space:nowrap}" +
      ".zu-sc-val.latest{font-weight:700}" +
      /* v250（用户规格）：柱间距收紧 20%——列宽 pitch 的柱白 = pitch−柱宽，柱宽改
       * calc(20% + 12px) 后白 = 0.8×pitch−12 = 旧白（pitch−15）×0.8，任意宽度恒精确 −20% */
      ".zu-sc-bar{display:block;width:100%;max-width:calc(20% + 12px);min-height:2px;border-radius:2.5px 2.5px 0 0;background:currentColor}" +
      ".zu-sc-bar.zu-ultra{background:linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%)}" +
      ".zu-sc-bar.zu-ultra::before{content:none}" +
      ".zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1px currentColor}" +
      ".zu-sc-col.cur .zu-sc-bar{box-shadow:0 0 0 1.3px currentColor,0 0 9px -2px currentColor}" +
      ".zu-sc-col:focus-visible .zu-sc-bar{box-shadow:0 0 0 1.5px var(--color-brand,#a3cfff),0 0 9px -2px var(--color-brand,#a3cfff)}" +
      ".zu-sc-x{height:29px;padding-top:4px;flex:0 0 29px;display:flex;flex-direction:column;align-items:center;gap:1px;font-variant-numeric:tabular-nums;font-size:10px;line-height:1.25;color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap}" +
      /* 信息卡挂 plot 内（top:0 相对柱区顶）：横滚时随内容滚动，盖住的列永远受
       * span capIn 约束（挂图表视口右缘会盖住滚动窗内的无约束高柱，review 实测） */
      ".zu-sc-card{position:absolute;top:0;right:0;z-index:2;pointer-events:none;background:var(--color-popover,#1c212b);border:1px solid var(--color-popover-border,rgba(255,255,255,.16));border-radius:8px;padding:3px 8px;box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:210px}" +
      ".zu-light .zu-sc-card{box-shadow:0 4px 14px rgba(15,23,42,.16)}" +
      /* 卡片字号固定 px：几何是 Y 轴约束的输入（CARD_H=36，v242 校准实高 35.6px），不随宿主字号漂移 */
      ".zu-sc-card-k{font-size:10px;line-height:1.2;color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap}" +
      ".zu-sc-card-v{font-variant-numeric:tabular-nums;font-size:13px;font-weight:700;line-height:1.2;white-space:nowrap}" +
      ".zu-sc-card-v i{font-style:normal;font-size:10px;font-weight:600;margin-left:5px;opacity:.9}" +
      /* v250 轮明细行（模型/Token/请求·费用）：行高 12+行距 2=14px 是 CARD_H 的输入；
       * 模型名等超长 ellipsis（全文在 title），数字等宽 */
      ".zu-sc-card-m{font-size:10px;line-height:1.2;margin-top:2px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".tbody::-webkit-scrollbar{width:8px}" +
      ".tbody::-webkit-scrollbar-thumb{background:var(--color-border,rgba(255,255,255,.14));border-radius:999px}" +
      /* 超限告警气泡（v39）：挂 body 的独立浮层（与 .tip 同套路，免受条面重建影响），
       * 红边警示 + 建议步骤 + 可点击复制的会话 ID；user-select:text 允许手动选中兜底。
       * 底色 = 客户端 destructive 掺背景色：深色下深红黑、浅色下淡粉，自动适配。 */
      ".zusage-exc{position:fixed;max-width:470px;" +
      "background:linear-gradient(180deg,rgba(41,18,22,.98),rgba(27,14,16,.98));" +
      "background:linear-gradient(180deg,color-mix(in srgb,var(--color-destructive,#ff2d55) 10%,var(--color-background,#1b0e10)),color-mix(in srgb,var(--color-destructive,#ff2d55) 5%,var(--color-background,#1b0e10)));" +
      "border:1px solid rgba(255,45,85,.4);border-color:color-mix(in srgb,var(--color-destructive,#ff2d55) 40%,transparent);" +
      "border-radius:12px;padding:12px 15px;" +
      "font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);" +
      "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.7;color:var(--color-foreground,#e9edf4);" +
      "box-shadow:0 12px 32px rgba(0,0,0,.5),0 4px 18px rgba(255,45,85,.12);white-space:normal;z-index:2147483647;" +
      "user-select:text;display:none}" +
      ".zusage-exc .xb-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}" +
      ".zusage-exc .xb-title{font-weight:700;color:var(--color-destructive,#ff5c77)}" +
      ".zusage-exc .xb-step{color:var(--color-foreground-subtle,#c6cdd9)}" +
      ".zusage-exc .xb-close{cursor:pointer;color:var(--color-foreground-subtlest,#8791a5);padding:2px 5px;border-radius:6px;font-size:calc(var(--ui-font-size,14px) + 2px);line-height:1}" +
      ".zusage-exc .xb-close:hover{color:var(--color-foreground,#fff);background:var(--color-hover,rgba(255,255,255,.08))}" +
      ".zusage-exc .xb-sid{color:var(--color-brand,#57c7ff);cursor:pointer;text-decoration:underline dotted}" +
      ".zusage-exc .xb-sid:hover{text-decoration-style:solid}" +
      ".zusage-exc .xb-copied{color:#3ecf8e;margin-left:6px;display:none}" +
      /* 白色主题程度性覆盖（v58.1）：颜色已全量走客户端变量随 .dark 自动翻转，
       * 这里只兜两类 —— 程度差（浅色下阴影/内高光减重、红字光晕收掉）与
       * 三档状态色加深版（高对比自调档，见 .ok 注释）。 */
      /* :not(.zu-in) 保特异性：in-card 形态（v80）自身声明 box-shadow:none 且定义在前，
       * 同特异性的浅色阴影会反超——透明无框条上浮出一圈浅影（review 抓获） */
      ".zusage-root.zu-light:not(.zu-in){box-shadow:inset 0 1px 0 rgba(255,255,255,.85),0 4px 14px rgba(15,23,42,.12),0 1px 3px rgba(15,23,42,.08)}" +
      ".zusage-root.zu-pill,.zusage-root.zu-pill.zu-light{box-shadow:none}" +
      ".tip.zu-pill-skin{background:var(--color-popover,var(--color-card,var(--color-background,#171717)));" +
      "border-color:var(--color-popover-border,var(--color-border,transparent));color:var(--color-foreground,#fafafa)}" +
      ".tip.zu-pill-skin .rt-h,.tip.zu-pill-skin .rt-row span{color:var(--color-foreground,#fafafa)}" +
      ".tip.zu-pill-skin .rt-row b,.tip.zu-pill-skin .rt-note,.tip.zu-pill-skin .rt-legend b,.tip.zu-pill-skin .rt-lsep{color:var(--color-foreground-subtle,#a1a1a1)}" +
      ".tip.zu-pill-skin .ttab{background:var(--color-hover,rgba(128,128,128,.12));color:var(--color-foreground-subtle,#a1a1a1)}" +
      ".tip.zu-pill-skin .ttab:hover{color:var(--color-foreground,#fafafa)}" +
      ".tip.zu-pill-skin .ttab.on{color:var(--color-brand,#3b82f6)}" +
      ".panel.zu-light{box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 12px 32px rgba(15,23,42,.14),0 2px 8px rgba(15,23,42,.08)}" +
      /* v81：反色底后 tip 的 inset 白高光在浅色主题（黑底 tip）上违和，浅色只调淡外阴影 */
      ".tip.zu-light{box-shadow:0 10px 28px rgba(15,23,42,.16),0 2px 6px rgba(15,23,42,.08)}" +
      ".zusage-exc.zu-light{box-shadow:0 12px 32px rgba(15,23,42,.14),0 4px 18px rgba(220,38,38,.1)}" +
      ".zu-light .exc{text-shadow:none}" +
      ".zu-light .ok{color:#0f9d6c}.zu-light .warm{color:#b6791a}.zu-light .hot{color:#d8482f}" +
      /* v127 速度新七档浅色深化值（规格初稿；150 以下沿用上面既有三档实测值不动）。
       * Ultra 浅色渐变同名覆盖（特异性更高），@supports 外回退纯紫 #6746d2。 */
      ".zu-light .zu-teal{color:#087d74}.zu-light .zu-sky{color:#0875a8}.zu-light .zu-azure{color:#405fd0}" +
      ".zu-light .zu-violet{color:#6249c6}.zu-light .zu-purple{color:#8042bd}.zu-light .zu-magenta{color:#9638a8}" +
      ".zu-light .zu-ultra{color:#6746d2}" +
      /* v232 柱体 Ultra 浅色渐变：特异性 (0,3,0) 压过上面 (0,2,0) 的 clip:text 组——
       * 柱体是无文字的盒子，被 text 裁剪会整根隐形（图例圆点同款教训）。 */
      ".zu-light .zu-sc-bar.zu-ultra{background:linear-gradient(100deg,#3156cb 0%,#6746d2 50%,#9139bf 100%);-webkit-background-clip:border-box;background-clip:border-box}" +
      /* v242:图例 ultra 圆点同款修正——下方 @supports 的 .zu-light .zu-ultra (0,2,0) 靠后,
       * 会把 (0,2,0) 圆点渐变裁到 text 上(9px 空盒=隐形),须 (0,3,0) 压回 border-box */
      ".zu-light .zu-legend-dot.zu-ultra{background:linear-gradient(100deg,#3156cb 0%,#6746d2 50%,#9139bf 100%);-webkit-background-clip:border-box;background-clip:border-box}" +
      /* background 简写会把 background-clip 重置回 border-box，浅色规则特异性更高——
       * 这里必须连带重申 clip，否则渐变整块糊在字底（截图验收抓获）。 */
      "@supports(-webkit-background-clip:text){" +
      ".zu-light .zu-ultra{background:linear-gradient(100deg,#3156cb 0%,#6746d2 50%,#9139bf 100%);" +
      "-webkit-background-clip:text;background-clip:text}" +
      ".zu-light .zu-ultra::before{background:linear-gradient(100deg,#3156cb 0%,#6746d2 50%,#9139bf 100%);" +
      "-webkit-background-clip:text;background-clip:text}}" +
      ".zu-light .xb-copied{color:#0c8a63}" +
      /* 减少动态偏好：关闭呼吸/闪烁与悬浮过渡 */
      "@media (prefers-reduced-motion:reduce){.exc,.dot,.zu-compact-dlg,.zu-compact-card{animation:none}" +
      ".it,.btn,.ttab,.panel label{transition:none}}" +
      /* v105 压缩上下文：弹层内胶囊按钮 + 确认弹框。配色全量引用客户端语义变量
       * （secondary/primary/popover/border/hover，明暗与 zai 主题自动跟随）；color-mix
       * 处加同值前置声明（不支持时落实色）。按钮复刻原生 hover:bg-secondary/80。 */
      ".zu-compact-btn{display:block;box-sizing:border-box;width:100%;height:36px;padding:0;border:0;border-radius:9999px;" +
      "background:var(--color-secondary,#e5e5e5);color:var(--color-foreground,#0a0a0a);" +
      "font-family:inherit;font-size:14px;font-weight:500;line-height:1;cursor:pointer;" +
      "transition:background .15s}" +
      ".zu-compact-btn:hover{background:var(--color-secondary,#e5e5e5);background:color-mix(in srgb,var(--color-secondary,#e5e5e5) 80%,transparent)}" +
      ".zu-compact-btn:active{background:var(--color-secondary,#e5e5e5);background:color-mix(in srgb,var(--color-secondary,#e5e5e5) 68%,transparent)}" +
      /* v193 布局：行上不得写任何 margin——宿主 body 的 space-y-3 是 Tailwind v4
       * :where() 零权重规则（margin-bottom 打在非末尾子元素上），自写 margin 会按
       * 类名权重压掉它（v190 的 6px 显挤、v192 的 margin:0 贴紧按钮都是这个坑）；
       * 不声明即回落容器原生 12px 节奏，与「平均缓存命中率」行距分割线同源。
       * 行内 flex 两端对齐，「调整」链接贴右缘。 */
      ".zu-ac-info{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;line-height:1.4;opacity:.7}" +
      ".zu-ac-link{text-decoration:underline;cursor:pointer;opacity:.9;flex:none}" +
      ".zu-ac-link:hover{opacity:1;color:var(--color-brand,#57c7ff)}" +
      /* v195 说明行：space-y v4 只写 margin-bottom，margin-top 无冲突可安全收紧间距 */
      ".zu-ac-hint{margin-top:-8px;font-size:11px;line-height:1.45;opacity:.6}" +
      /* v190：高亮改琥珀左条+淡底（--color-brand 在宿主主题可能是白色系，描边观感像输入框焦点） */
      ".zu-settings label.zu-ac-flash{background:rgba(245,185,68,.10);box-shadow:inset 3px 0 0 #f5b944;" +
      "border-radius:6px;transition:background .3s,box-shadow .3s}" +
      ".zu-compact-dlg{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.6);animation:zuCptFade .1s ease-out}" +
      ".zu-compact-card{box-sizing:border-box;width:min(92vw,384px);padding:20px;border-radius:16px;" +
      "background:var(--color-popover,#fff);color:var(--color-foreground,#0a0a0a);" +
      "border:1px solid var(--color-border,rgba(0,0,0,.1));box-shadow:0 25px 50px -12px rgba(0,0,0,.45);" +
      "font-family:inherit;font-size:14px;line-height:1.5;animation:zuCptZoom .1s ease-out}" +
      ".zu-compact-title{font-size:16px;font-weight:600}" +
      ".zu-compact-desc{padding-top:8px;color:var(--color-foreground-subtle,#8791a3)}" +
      ".zu-compact-desc b{color:var(--color-foreground,#0a0a0a);font-weight:500;font-variant-numeric:tabular-nums}" +
      ".zu-compact-hint{margin-top:8px;font-size:12.5px;line-height:1.45;color:var(--color-foreground-subtle,#8791a3);opacity:.85}" +
      ".zu-compact-err{display:none;margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(220,38,38,.1);color:#dc2626;font-size:13px}" +
      ".zu-compact-err.on{display:block}" +
      ".zu-compact-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}" +
      ".zu-compact-foot button{height:36px;padding:0 16px;border-radius:8px;font-family:inherit;font-size:14px;cursor:pointer;" +
      "transition:background .15s,opacity .15s}" +
      ".zu-compact-cancel{background:transparent;border:1px solid var(--color-border,rgba(0,0,0,.1));color:var(--color-foreground,#0a0a0a)}" +
      ".zu-compact-cancel:hover{background:var(--color-hover,#e5e5e5)}" +
      ".zu-compact-ok{border:0;background:var(--color-primary,#0a0a0a);color:var(--color-primary-foreground,#fff)}" +
      ".zu-compact-ok:hover{opacity:.8}" +
      ".zu-compact-ok:disabled{opacity:.5;cursor:default}" +
      "@keyframes zuCptFade{from{opacity:0}to{opacity:1}}" +
      "@keyframes zuCptZoom{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}";

    /* 结构：条撑满卡片宽后 .zu-main 占满剩余宽、条目+分隔线默认 space-between 均匀分布
     * （v226 可经 ⚙「水平对齐」改居左/居右，均分仍为缺省），⚙ 落在最右缘（内容超宽时分级收缩、
     * 极限右缘渐隐 .zu-clip）；面板 fixed 挂 body，由 position*Panel 按条矩形定位在条上方（v80 迁移，见挂载处注） */
    var bar = document.createElement("div");
    bar.className = "zusage-root";
    bar.setAttribute("data-zusage-slot", String(slot));   // v169：多实例去重判据（Windows 最小化/还原双条 dedup 用）
    if (slot === 0) bar.id = "zusage-bar";
    bar.style.display = "none";   // 定位成功前不显示（避免占位）
    bar.innerHTML = '<span class="zu-main">…</span>' +
      '<button type="button" class="btn zu-gear" aria-label="' + L("打开状态条设置", "Open status bar settings") + '" aria-expanded="false" aria-haspopup="dialog">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9.5 2h5l.6 2.5 1.7 1 2.5-.7 2.5 4.4-1.9 1.8v2l1.9 1.8-2.5 4.4-2.5-.7-1.7 1-.6 2.5h-5l-.6-2.5-1.7-1-2.5.7-2.5-4.4L4.1 13v-2L2.2 9.2l2.5-4.4 2.5.7 1.7-1z"/><circle cx="12" cy="12" r="3.5"/></svg>' +
      '<span class="zu-gear-dot" aria-hidden="true"></span></button>';
    var ariaLiveState = document.createElement("span");
    ariaLiveState.className = "zu-sr-only";
    ariaLiveState.setAttribute("role", "status");
    ariaLiveState.setAttribute("aria-live", "polite");
    ariaLiveState.setAttribute("aria-atomic", "true");
    bar.appendChild(ariaLiveState);
    var panel = document.createElement("div");
    panel.className = "panel zu-settings";
    /* issue #55：这三个 var 必须先于下方 buildPanel() 的调用完成赋值——var 只提升声明不提升
     * 赋值，而 buildPanel → syncUpdate 首轮执行就会读它们（赋值语句曾排在调用点之后，
     * v1.5.2 首轮读到 undefined 抛 TypeError 拖垮实例创建）。配套函数是声明有提升，留在原位。 */
    var srcListSig = "", sourceFeedback = {};
    var SRC_FIELD_LABELS = {
      apiKey: L("API Key", "API Key"), cookie: L("控制台 Cookie", "Console Cookie"), token: L("Token", "Token"),
      accessKeyId: L("AccessKeyId", "AccessKeyId"), secretAccessKey: L("SecretAccessKey", "SecretAccessKey"),
      planCredits: L("套餐 Credits 总量", "Plan credits"), planStart: L("计费锚日 YYYY-MM-DD", "Billing anchor day"),
    };
    var PROGRESS_STAGES = ["download", "verify", "install", "sync"];
    function settingRow(input, title, note) {
      return '<label>' + input + '<span>' + title + '<em>' + note + '</em></span></label>';
    }
    /* v202 更新日志卡片骨架（随语言由 buildPanel 重建；内容由 syncNotes 按状态幂等填充） */
    function notesCardHtml() {
      return '<div class="zu-settings-card zu-notes-card">' +
      '<div class="zu-notes-head"><span class="zu-notes-title">' + L("更新日志", "Release notes") + '</span>' +
      '<span class="zu-notes-badge"></span>' +
      '<button type="button" class="zu-notes-back" hidden></button>' +
      '<button type="button" class="zu-notes-history-btn" hidden>' + L("历史版本", "Version history") + '</button></div>' +
      '<div class="zu-notes-meta" role="status" aria-live="polite"></div>' +
      '<div class="zu-notes-body" aria-busy="false"></div>' +
      '<div class="zu-notes-foot">' +
      '<button type="button" class="zu-notes-toggle" hidden></button>' +
      '<button type="button" class="zu-notes-link" hidden></button>' +
      '<button type="button" class="zu-notes-retry" hidden>' + L("重试", "Retry") + '</button></div>' +
      '<div class="zu-notes-history" hidden></div></div>';
    }
    /* 更新日志卡片运行态（必须在下方早期 buildPanel() 调用前赋值——var 不提升初始值，issue #55 同款时序） */
    var notesSel = { version: "", explicit: false };   // 用户粘性选择：explicit 时轮询不切回默认
    var notesReqSeq = 0, notesListSeq = 0;
    var notesLoadedVersion = "", notesAutoTriedVersion = "", notesRequestedAt = 0;
    var NOTES_LOADING_TIMEOUT_MS = 120000;   // 回执丢失（切页/销毁静默丢弃）时由轮询驱动的 syncNotes 降级为可重试
    var notesResult = null, notesError = null;   // 与 notesLoadedVersion 配对的最近一次拉取结果
    var notesExpanded = false, notesBodySig = "";
    var notesHistory = null, notesHistoryError = null, notesHistoryState = "", notesHistorySig = "";
    /* ---------- 分区导航（v100，ZCode 设置侧栏同款交互）：左栏三组、内容区单分区显隐 ---------- */
    var ZU_NAV_GROUPS = [
      { id: "basics", zh: "基础", en: "Basics" },
      { id: "data", zh: "数据与统计", en: "Data & stats" },
      { id: "maint", zh: "维护", en: "Maintenance" },
    ];
    var ZU_SECTIONS = [
      { id: "display", group: "basics", zh: "状态条显示", en: "Display items",
        icon: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>' },
      { id: "general", group: "basics", zh: "通用", en: "General",
        icon: '<path d="M4 7h4m5 0h7M4 17h9m5 0h2"/><circle cx="10.5" cy="7" r="2.5"/><circle cx="15.5" cy="17" r="2.5"/>' },
      { id: "rotator", group: "basics", zh: "状态轮播", en: "Status rotator",
        icon: '<path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/>' },
      { id: "stats", group: "data", zh: "回答统计", en: "Reply statistics",
        icon: '<path d="M4 4v16h16M8 16v-4m5 4V7m5 9v-6"/>' },
      { id: "quota", group: "data", zh: "套餐额度", en: "Plan quota",
        icon: '<path d="M4.2 18a9 9 0 1 1 15.6 0M12 13l4-4M6 18h12"/><circle cx="12" cy="13" r="1"/>' },
      { id: "update", group: "maint", zh: "插件更新", en: "Plugin updates",
        icon: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 21H3v-5"/>' },
      { id: "about", group: "maint", zh: "关于数据", en: "About the data",
        icon: '<circle cx="12" cy="12" r="9"/><path d="M11 11h1v6m-1 0h3m-2-10v.1"/>' },
    ];
    function activeSettingsSec() {
      for (var i = 0; i < ZU_SECTIONS.length; i++) if (ZU_SECTIONS[i].id === state.settingsSec) return state.settingsSec;
      return ZU_SECTIONS[0].id;
    }
    function secOpen(id) { return activeSettingsSec() === id ? "" : " hidden"; }
    function navHtml() {
      var active = activeSettingsSec();
      var html = '<nav class="zu-settings-nav" aria-label="' + L("设置分区", "Settings sections") + '">';
      for (var g = 0; g < ZU_NAV_GROUPS.length; g++) {
        var grp = ZU_NAV_GROUPS[g], gid = "zu-navgroup-" + grp.id;
        html += '<div class="zu-settings-navgroup" role="group" aria-labelledby="' + gid + '">' +
          '<div class="zu-navcap" id="' + gid + '">' + L(grp.zh, grp.en) + '</div>';
        for (var s = 0; s < ZU_SECTIONS.length; s++) {
          var it = ZU_SECTIONS[s];
          if (it.group !== grp.id) continue;
          html += '<button type="button" class="zu-navitem" data-sec="' + it.id + '"' + (it.id === active ? ' aria-current="page"' : '') +
            ' title="' + L(it.zh, it.en) + '"><span class="zu-nav-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + it.icon + '</svg></span>' +
            '<span class="zu-nav-label">' + L(it.zh, it.en) + '</span>' +
            (it.id === "update" ? '<span class="zu-nav-dot" aria-hidden="true"></span>' : '') + '</button>';
        }
        html += '</div>';
      }
      return html + '</nav>';
    }
    /* 面板文案可随语言重建（事件走 panel 级委托，重建不丢监听） */
    function buildPanel() {
      var oldBody = panel.querySelector(".zu-settings-body");
      var scrollTop = oldBody ? oldBody.scrollTop : 0;
      panel.innerHTML =
      '<div class="zu-settings-head"><div class="phead">' + L("状态条设置", "Status bar settings") + '<span class="pver zu-settings-version"></span></div>' +
      '<button type="button" class="zu-settings-close" aria-label="' + L("关闭设置", "Close settings") + '">✕</button></div>' +
      '<div class="zu-settings-layout">' + navHtml() +
      '<div class="zu-settings-body" tabindex="0" role="region" aria-label="' + L("状态条设置选项", "Status bar settings options") + '">' +
      '<section class="zu-settings-section" data-sec="display"' + secOpen("display") + '><div class="cap">' + L("状态条显示", "Display items") + '</div><div class="zu-settings-card">' +
      '<div class="zu-theme-title">' + L("状态条样式", "Status bar style") + '</div>' +
      '<div class="zu-theme-options" role="radiogroup" aria-label="' + L("状态条样式", "Status bar style") + '">' +
      '<label><input type="radio" class="zu-theme-choice" name="zu-theme-' + slot + '" value="default"><span>' + L("默认", "Default") + '</span></label>' +
      '<label><input type="radio" class="zu-theme-choice" name="zu-theme-' + slot + '" value="pill"><span>' + L("药丸", "Pill") + '</span></label>' +
      '<label><input type="radio" class="zu-theme-choice" name="zu-theme-' + slot + '" value="compact"><span>' + L("精简", "Compact") + '</span></label></div>' +
      '<div class="pnote">' + L("精简：隐藏悬浮条，生成速度移到输入框工具行前导区（Git 状态左侧），悬停它可看各格摘要并打开本设置。六个格全部关闭时自动转为精简，重新打开任一格即恢复原样式。", "Compact: hides the floating bar; the generation speed moves into the composer toolbar's leading group (left of the Git status chip) — hover it for cell summaries and a shortcut to these settings. With all six cells off the style switches to Compact automatically, and restores once any cell is turned back on.") + '</div>' +
      '<div class="zu-just-block"' + (state.theme === "default" ? '' : ' style="display:none"') + '>' +
      '<div class="zu-theme-title">' + L("水平对齐", "Horizontal alignment") + '</div>' +
      '<div class="zu-theme-options" role="radiogroup" aria-label="' + L("水平对齐", "Horizontal alignment") + '">' +
      '<label><input type="radio" class="zu-just-choice" name="zu-just-' + slot + '" value="between"' + (state.barJust === "between" ? " checked" : "") + '><span>' + L("均分对齐", "Space between") + '</span></label>' +
      '<label><input type="radio" class="zu-just-choice" name="zu-just-' + slot + '" value="start"' + (state.barJust === "start" ? " checked" : "") + '><span>' + L("居左对齐", "Align left") + '</span></label>' +
      '<label><input type="radio" class="zu-just-choice" name="zu-just-' + slot + '" value="end"' + (state.barJust === "end" ? " checked" : "") + '><span>' + L("居右对齐", "Align right") + '</span></label></div>' +
      '<div class="pnote">' + L("仅默认样式生效：均分为格铺满整条，居左/居右时格靠一侧聚拢，⚙ 齿轮仍在最右。", "Applies to the Default style only: space between spreads the cells across the bar; left/right packs them to one side — the gear stays at the far right.") + '</div></div>' +
      settingRow('<input type="checkbox" data-k="turn">', L("本轮", "Current turn"), L("tokens、请求次数、耗时与首字延迟", "Tokens, requests, duration and first-token latency")) +
      settingRow('<input type="checkbox" data-k="win">', L("会话累计", "Session total"), L("当前会话的 tokens、轮数与请求次数", "Tokens, turns and requests in this session")) +
      settingRow('<input type="checkbox" data-k="proj">', L("项目累计", "Project total"), L("本项目所有会话的消耗（含子代理），按目录归属", "Usage across all sessions in this project (sub-agents incl.), grouped by directory")) +
      settingRow('<input type="checkbox" data-k="tools">', L("工具调用", "Tool calls"), L("悬停查看各工具明细与错误", "Hover for per-tool details and errors")) +
      settingRow('<input type="checkbox" data-k="today">', L("今日合计", "Today's total"), L("今天所有会话的消耗", "Usage across all sessions today")) +
      settingRow('<input type="checkbox" data-k="sub">', L("子代理", "Sub-agents"), L("悬停或点击状态条上的子代理查看统计", "Hover or click the bar item for sub-agent stats")) +
      settingRow('<input type="checkbox" data-k="subRate">', L("子代理行内速率", "Sub-agent row rate"), L("在会话流的 Agent 工具行内实时显示各子代理 tok/s（运行期估算，完成后切换为真实平均速率；悬停看明细）。默认开启。", "Shows each sub-agent's live tok/s inside its Agent tool row (running estimate, actual average after completion; hover for details). On by default.")) +
      settingRow('<input type="checkbox" data-k="git">', L("Git 状态", "Git status"), L("工具行显示当前分支、↑领先 ↓落后与未提交改动（+插入行 -删除行 ?未跟踪）；优先挂在「电脑操作」右侧，缺失时留在左侧操作区末尾；仅本地仓库", "Branch, ↑ahead ↓behind and uncommitted changes (+ins -del ?untracked) in the toolbar; beside Computer Use, or at the end of the left action group when unavailable; local repositories only")) +
      '</div></section>' +
      '<section class="zu-settings-section" data-sec="general"' + secOpen("general") + '><div class="cap">' + L("通用", "General") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="text" class="zu-ctxov" inputmode="numeric" aria-label="' + L("上下文窗口", "Context window") + '" placeholder="' + L("自动（按模型）", "Auto (model)") + '">', L("上下文窗口", "Context window"), L("留空自动识别，优先使用客户端数值；手动值以 token 为单位，按整数读取", "Leave empty for automatic detection, preferring the client value; manual values are read as integer tokens")) +
      settingRow('<input type="checkbox" class="zu-ctx-enh">', L("上下文按钮增强", "Context button enhancement"), L("在输入框上下文按钮上显示环形用量填充、档位颜色与百分比；关闭即还原原生形态（重置卡徽标不受影响）。默认开启。", "Adds a ring fill, tier color and percentage to the context button; off restores the native look (reset card badge is unaffected). On by default.")) +
      settingRow('<input type="checkbox" class="zu-cpt-btn">', L("压缩上下文按钮", "Compact context button"), L("在「上下文容量」弹层内显示「压缩上下文」按钮（点击后需二次确认，把会话历史总结压缩以释放上下文窗口）。关闭即不再显示；自动压缩阈值行不受影响，位置上移补位。默认开启。", "Shows the Compact context button inside the context-usage popup (with a confirmation step that summarizes the conversation to free context window space). Off hides it; the auto-compact threshold row is unaffected and moves up into the button's place. On by default.")) +
      settingRow('<input type="checkbox" class="zu-cost-enable">', L("预估费用", "Estimated cost"), L("悬停本轮/会话累计/项目累计/今日合计时显示按 models.dev 官方模型价格估算的费用（USD×汇率折 ¥；无汇率时显示 $ 原值；模型匹配不到价格按默认均价估算）。启动后每 12 小时静默同步一次价表与汇率，只下载不上传，可在配置文件关闭。默认开启。", "Shows estimated cost when hovering the stat cells, priced at official models.dev rates (USD × exchange rate as ¥; falls back to $ without a rate; unmatched models use a default average). The price table and FX rate sync silently every 12h after startup — download only, nothing uploaded; can be disabled in the config file. On by default.")) +
      settingRow('<input type="checkbox" class="zu-tip-click">', L("点击激活悬浮窗口", "Click to open popups"), L("开启后状态条统计卡与子代理面板改为点击才打开（再点同一格、按 Escape 或移出条面收起）；关闭时悬停立即显示。键盘 Tab 聚焦两种模式下都即时打开。默认关闭。", "On: bar stat cards and the sub-agent panel open on click only (click the same cell again, press Escape or move off the bar to close); off: they show immediately on hover. Keyboard Tab focus opens immediately in both modes. Off by default.")) +
      /* v179 自动压缩阈值注入 → v188 按验收反馈简化：只留百分比（留空=跟随引擎默认），
         开关默认开（主进程 auto_compact_patch 缺省开）；标题带「上下文」限定。 */
      settingRow('<input type="checkbox" class="zu-ac-enable">', L("自动压缩上下文阈值注入", "Auto-compact context threshold injection"), L("给客户端引擎打补丁，把「到达阈值自动压缩上下文」的触发点改为可配置（引擎内置约在窗口 83% 处）。默认开启；补丁按引擎版本白名单注入，不支持的版本自动跳过并提示，关闭开关即还原引擎。开关对新会话生效；下方数值改完即生效（留空=跟随引擎默认）。只影响桌面客户端内置引擎，终端 CLI 不受影响。", "Patches the client engine so the auto-compact trigger point becomes configurable (the built-in engine fires around 83% of the window). On by default; patching is allow-listed per engine build, unsupported builds are skipped with a notice, and turning the switch off restores the engine. New sessions pick up the patch; the value below applies immediately (leave empty to follow the engine default). Only the desktop client's built-in engine is affected; the terminal CLI is not.")) +
      settingRow('<input type="text" class="zu-ac-value" inputmode="numeric" aria-label="' + L("压缩上下文阈值数值", "Context compaction threshold value") + '" placeholder="' + L("留空=跟随引擎默认", "Empty = engine default") + '">', L("压缩上下文阈值数值（%）", "Context compaction threshold value (%)"), L("压缩触发点占总窗口的百分比，取 30-99；留空=跟随引擎默认。任何形式都会被钳到不早于有效窗口的 1%，避免连环压缩。", "Compaction trigger as a percentage of the full context window, 30-99; leave empty to follow the engine default. Any form is clamped to no earlier than 1% of the effective window to prevent compaction loops.")) +
      '<div class="zu-ac-status" role="status"></div>' +
      /* 万/亿开关只在中文界面出现（英文始终 K/M/B，见 fmt），因此文案不走 L() */
      (state.lang === "en" ? "" : settingRow('<input type="checkbox" class="zu-cn-num">', "中文单位（万/亿）", "token 数量以万/亿显示，默认开启")) +
      settingRow('<input type="checkbox" class="zu-force-kmb">', L("强制 K/M/B 单位", "Force K/M/B units"), L("token 数量使用 K/M/B，默认关闭；不影响请求数和 Git 计数。", "Use K/M/B for token amounts; off by default. Request and Git counts are unaffected.")) +
      settingRow('<input type="checkbox" class="zu-pp-enable">', L("项目完整路径", "Full project paths"), L("「编辑项目」弹窗的源文件夹在名称下方显示完整路径；长路径自动换行，多文件夹逐行显示。点击文件夹行会用系统文件管理器打开该目录（macOS Finder / Windows 资源管理器；远程项目的路径在本机无意义，不响应）。默认开启。", "Shows the full path below each folder name in the Edit Project dialog; long paths wrap, one block per folder. Click a folder row to open it in your file manager (Finder on macOS, Explorer on Windows; remote project paths are skipped). On by default.")) +
      settingRow('<input type="checkbox" class="zu-cmdk-widen">', L("命令中心加宽", "Wider command center"), L("把宿主 ⌘K 搜索弹框（命令中心、任务搜索等）放宽到窗口宽度的 80%、高度的 80%；小窗口保持原生尺寸。关闭后恢复原生尺寸。默认开启。", "Widens the host ⌘K search dialogs (command center, task search, …) to 80% of the window width and height; small windows keep the native size. Turning it off restores the native size. On by default.")) +
      '<div class="zu-settings-langs"><label><input type="radio" name="zu-lang" value="zh"><span>中文</span></label>' +
      '<label><input type="radio" name="zu-lang" value="en"><span>English</span></label></div></div></section>' +
      '<section class="zu-settings-section" data-sec="stats"' + secOpen("stats") + '><div class="cap">' + L("回答统计", "Reply statistics") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="checkbox" class="zu-rate-line">', L("回答末尾追加统计行", "Append stats to each reply"), L("切换后立即重扫：关闭会撤下插件生成的统计行，开启会补回可用记录。下一次提问沿用该设置；历史正文和已缓存统计行不重算。", "Rescans immediately: off removes plugin-generated lines; on restores available records. Applies to the next prompt; historical text and cached statistics are not recalculated.")) +
      '</div></section>' +
      '<section class="zu-settings-section" data-sec="quota"' + secOpen("quota") + '><div class="cap">' + L("套餐额度", "Plan quota") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="checkbox" class="zu-quota-enable">', L("显示套餐额度", "Show plan quota"), L("在输入框上下文按钮左侧显示当前登录账号编码套餐的已用比例与重置时间（含 Start Plan 免费档池的已用比例与到期时间；账号级套餐池，不是单个模型独享）。默认开启，关闭即停查询。点击 chip 立即刷新。", "Shows the signed-in account's coding-plan usage and reset time left of the context button (plus the Start Plan free tier's usage and expiry; account-level pool, not per model). On by default; turning it off stops the queries. Click the chip to refresh.")) +
      settingRow('<input type="checkbox" class="zu-quota-remain">', L("显示剩余额度", "Show remaining quota"), L("把额度 chip 与悬停明细改为按剩余比例展示（剩余% = 100 − 已用%，同一额度窗口的补数）；段位颜色仍按已用量判定：剩得越少越红。账户余额与 Key 剩余额度本身就是剩余口径，不受影响。默认关闭（显示已用）。", "Switches the quota chip and its hover details to remaining percentages (remaining% = 100 − used%, the complement of the same window); segment colors still follow the used amount — the less left, the redder. Account balance and remaining key quota are already remaining-based and unaffected. Off by default (shows used).")) +
      settingRow('<input type="checkbox" class="zu-rst-enable">', L("重置卡徽标", "Reset card badge"), L("在额度 chip 左侧显示账号可用的额度重置卡（次数、到期倒计时，悬停看每张卡明细）。默认开启。独立于额度开关：关闭「显示套餐额度」后，本开关开启时仍查询重置卡（仅官方 reset/status 只读接口，发往 zcode.z.ai）。需要 ZCode 登录态；仅 API Key 用户与团队套餐无重置卡。", "Shows available quota reset cards left of the quota chip (count, countdown; hover for per-card details). On by default. Independent of the quota toggle: when the quota chip is off, this keeps polling the official read-only reset/status endpoint (zcode.z.ai). Requires the ZCode sign-in; API-key-only users and team plans have no reset cards.")) +
      settingRow('<input type="text" class="zu-rst-cdh" inputmode="numeric" aria-label="' + L("重置倒计时阈值（小时）", "Reset countdown threshold (hours)") + '">', L("倒计时阈值（小时）", "Countdown threshold (hours)"), L("重置卡剩余时间短于该值时在徽标上显示倒计时，默认 24（1–168）。", "Show a countdown on the badge when a card has less time left than this, in hours; default 24 (1–168).")) +
      '<div class="pnote">' + L("开启后主进程读取本机 ZCode 登录凭据（~/.zcode/v2/credentials.json）查询官方套餐接口：凭据仅在内存使用、不落盘、不进日志与诊断：内置套餐发往 bigmodel.cn / api.z.ai 官方域，Start Plan 免费档发往 zcode.z.ai；自定义供应商余额用其自己的 key，只发其官方域（api.deepseek.com、openrouter.ai、api.siliconflow.cn、api.minimaxi.com、api.kimi.com、api.commandcode.ai、api.cline.bot、api.anthropic.com、platform.xiaomimimo.com、open.volcengineapi.com、opencode.ai 等）或你配置的中转站本域。套餐支持 BigModel / Z.ai 个人档与多家 Token Plan/余额（见下方数据源列表）；团队套餐暂不支持，识别不了余额形状的中转不显示。启用 Anthropic 源时会读取本机 Claude Code 的登录凭据（~/.claude/.credentials.json）查询其官方用量接口，同样仅在内存使用。",
        "When on, credentials are read in memory to query plan/balance endpoints and never reach disk, logs or diagnostics: built-in plans go to bigmodel.cn / api.z.ai, the Start Plan free tier to zcode.z.ai; custom-provider lookups use that provider's own key and go only to its official domain (api.deepseek.com, openrouter.ai, api.siliconflow.cn, api.minimaxi.com, api.kimi.com, api.commandcode.ai, api.cline.bot, api.anthropic.com, platform.xiaomimimo.com, open.volcengineapi.com, opencode.ai, ...) or the relay base URL you configured — never anywhere else. Multiple Token Plan / balance vendors are supported (see the source list below); team plans are not. Enabling the Anthropic source additionally reads the local Claude Code credential (~/.claude/.credentials.json) for its official usage endpoint, in memory only.") + '</div>' +
      '<div class="zu-src-list"></div>' +
      '<div class="pnote">' + L("每个数据源独立启用、独立刷新；凭据只保存在本机 quota-secrets.json（0600），不进日志与诊断。标 * 的厂商为源码转写适配，未经真实账号实测。", "Each source has its own toggle and refresh; credentials stay in the local quota-secrets.json (0600), never in logs or diagnostics. Vendors marked * are ported from reference projects without live verification.") + '</div></div></section>' +
      '<section class="zu-settings-section" data-sec="update"' + secOpen("update") + '><div class="cap">' + L("插件更新", "Plugin updates") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="checkbox" class="zu-auto-update">', L("自动更新", "Automatic updates"), L("每 1 小时检查并安装新版，默认开启", "Check and install every hour; on by default")) +
      settingRow('<input type="checkbox" class="zu-restart-notice">', L("更新后在状态条显示红点提醒", "Show a status bar badge after updates"), L("插件的更新包含需重启 ZCode 的文件时，状态条 ⚙ 与左侧「插件更新」项显示红点，点进「插件更新」分区后消失；关闭后不再显示。更新成功且无需重启（已自动热重载）不显示红点。", "When an update includes files that need a ZCode restart, the status bar gear and the Plugin updates entry show a red dot until you open that section; turn off to hide. No dot when an update finished without a restart (hot-reloaded automatically).")) +
      '<div class="pnote">' + L("更新器变更需完全退出并重开 ZCode 后生效；客户端关闭期间不检查。", "Updater changes take effect after fully quitting and reopening ZCode; no checks run while the app is closed.") + '</div>' +
      '<div class="zu-settings-detail"><div class="zu-upd-banner" hidden></div><div class="zu-update-actions"><button type="button" data-update="check">' + L("检查更新", "Check for updates") + '</button><button type="button" data-update="update">' + L("立即更新", "Update now") + '</button><button type="button" data-update="relaunch">' + L("重启 ZCode", "Restart ZCode") + '</button></div>' +
      '<div class="pnote zu-update-status" role="status" aria-live="polite"></div>' +
      '<div class="zu-update-progress" hidden>' +
      '<div class="zu-progress-row" data-progress="download"><span class="zu-progress-label">' + L("下载", "Download") + '</span><div class="zu-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="zu-progress-fill"></div></div><span class="zu-progress-value"></span></div>' +
      '<div class="zu-progress-row" data-progress="install"><span class="zu-progress-label">' + L("安装", "Install") + '</span><div class="zu-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="zu-progress-fill"></div></div><span class="zu-progress-value"></span></div>' +
      '</div>' +
      '<div class="pnote">' + L("仅更新此插件。GitHub/GitCode 来源会联网，本地目录来源只检查本地文件，不上传用量数据。", "Only this plugin is updated. GitHub/GitCode sources use the network; directory sources check local files. Usage data is never uploaded.") + '</div></div>' +
      /* v202 更新日志卡片：骨架静态，内容由 syncNotes 按状态填充（幂等签名，不抢滚动/焦点） */
      notesCardHtml() + '</section>' +
      '<section class="zu-settings-section" data-sec="about"' + secOpen("about") + '><div class="cap">' + L("关于数据", "About the data") + '</div><div class="pnote">' +
      L("数据库统计：只读 ~/.zcode/cli/db/db.sqlite，请求完成后入库；总 token 为输入加输出，缓存已含在输入中，思考已含在输出中。", "Database statistics: read-only ~/.zcode/cli/db/db.sqlite, written after requests complete. Total tokens = input + output; cache is included in input and thinking in output.") + '</div><div class="pnote">' +
      L("生成速度：只读渲染器状态桥在生成时按字符增量估算，完成后切换为真实速度；桥不可用时回退数据库最近有效段。", "Generation speed: the read-only renderer bridge estimates from text deltas while running and uses actual speed after completion; without the bridge it falls back to the latest valid database segment.") + '</div><div class="pnote">' +
      L("联网边界：额度源查询对应账号的套餐或余额接口；插件更新可联网下载代码与读取发布日志（源码渠道为注册仓库的同号 Release 参考）。额度不是本地 token 统计推算值。SSH 数据查询使用已配置通道。", "Network boundaries: quota sources query account plan/balance endpoints; plugin updates can download code and read release notes (source channels read the registered repo's same-version release as reference). Quota is not inferred from local token usage. SSH statistics use configured connections.") + '</div></section></div></div>' +
      '<div class="zu-settings-foot"><button type="button" class="zu-settings-scroll"></button>' +
      '<span class="zu-settings-feedback-status" role="status" aria-live="polite"></span>' +
      '<button type="button" class="zu-settings-feedback">' + L("反馈问题", "Report an issue") + '</button></div>';
      panel.querySelectorAll('input[name=zu-lang]').forEach(function (r) {
        r.checked = state.lang === r.value;
      });
      panel.querySelectorAll('.zu-theme-choice').forEach(function (r) {
        r.checked = state.theme === r.value;
      });
      panel.querySelectorAll('.zu-just-choice').forEach(function (r) {
        r.checked = state.barJust === r.value;
      });
      /* 重建后回填全部控件状态（语言切换路径不走 syncPanel）：checkbox 按 state.show、
         上下文窗口输入框按 state.ctxOv——否则切语言后勾选态清空、首次点击语义反转 */
      panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
        cb.checked = !!state.show[cb.dataset.k];
      });
      var ovInput = panel.querySelector(".zu-ctxov");
      if (ovInput) ovInput.value = state.ctxOv;
      var kmbBox = panel.querySelector(".zu-force-kmb");
      if (kmbBox) kmbBox.checked = !!state.forceKmb;
      var cnBox = panel.querySelector(".zu-cn-num");
      if (cnBox) cnBox.checked = !!state.cnNum;
      var ppBox = panel.querySelector(".zu-pp-enable");
      if (ppBox) ppBox.checked = !!state.projPath;
      var ctxEnhBox = panel.querySelector(".zu-ctx-enh");
      if (ctxEnhBox) ctxEnhBox.checked = !!state.ctxEnh;
      var cptBox = panel.querySelector(".zu-cpt-btn");
      if (cptBox) cptBox.checked = !!state.ctxCpt;
      var costBox = panel.querySelector(".zu-cost-enable");
      if (costBox) costBox.checked = !!state.cost;
      var cwBox = panel.querySelector(".zu-cmdk-widen");
      if (cwBox) cwBox.checked = !!state.cmdkW;
      var tipClickBox = panel.querySelector(".zu-tip-click");
      if (tipClickBox) tipClickBox.checked = !!state.tipClick;
      var qrBox = panel.querySelector(".zu-quota-remain");
      if (qrBox) qrBox.checked = !!state.quotaRemain;
      if (typeof zuRotatorSyncPanel === "function") zuRotatorSyncPanel(panel);
      syncUpdate();
      panel.querySelector(".zu-settings-body").scrollTop = scrollTop;
      if (panel.setAttribute) panel.setAttribute("aria-label", L("状态条设置", "Status bar settings"));
      syncSettingsScroll();
    }
    function syncSettingsScroll() {
      var body = panel.querySelector(".zu-settings-body");
      var button = panel.querySelector(".zu-settings-scroll");
      if (!body || !button) return;
      /* 窄面板（<620px）导航收成 icon rail：ZCode max-lg icon-only 同语义，按面板实测宽切换 */
      panel.classList.toggle("zu-nav-icons", !!panel.offsetWidth && panel.offsetWidth < 620);
      var overflow = body.scrollHeight > body.clientHeight + 2;
      var more = overflow && body.scrollHeight - body.clientHeight - body.scrollTop > 2;
      panel.classList.toggle("zu-settings-more", more);
      button.disabled = !more;
      var text = more ? L("↓ 下方还有设置 · 滚动或点击查看更多", "↓ More settings below · scroll or click to see more") :
        overflow ? L("✓ 已到底部 · 所有设置已展示", "✓ End of settings") : L("所有设置已展示", "All settings are visible");
      if (button.textContent !== text) button.textContent = text;
    }
    function positionSettingsPanel() {
      if (!panel.classList.contains("open")) return;
      var br = bar.getBoundingClientRect();
      var panelCard = state.theme === "pill" ? (pillSurface || cardCache) : null;
      if (state.theme === "compact" && !panelCard && cardCache && cardCache.isConnected) panelCard = cardCache;   // v146：条隐藏时对齐输入卡（几何/宽度锚）
      var cardRect = panelCard ? panelCard.getBoundingClientRect() : null;
      var anchorTop = cardRect ? cardRect.top : br.top;
      var height = Math.max(0, Math.floor(anchorTop - 18));
      /* 打开时以视口高度提供稳定阅读区域，切页不缩放；可用空间减少时只收紧。 */
      if (!panel.style.height) {
        var preferred = Math.floor((typeof innerHeight === "number" ? innerHeight : window.innerHeight) * .9);
        panel.style.height = Math.max(0, Math.min(preferred, height)) + "px";
      } else if ((parseInt(panel.style.height, 10) || 0) > height) {
        panel.style.height = height + "px";
      }
      var value = height + "px";
      if (panel.style.getPropertyValue("--zu-settings-height") !== value) panel.style.setProperty("--zu-settings-height", value);
      var panelWidth = cardRect ? Math.min(cardRect.width, Math.max(0, innerWidth - 16))
        : (br.width || Math.min(560, Math.max(0, innerWidth - 16)));   // v146：精简且无卡片时给可用宽兜底（条 rect 为 0）
      value = panelWidth + "px";
      if (panel.style.width !== value) panel.style.width = value;
      /* v80：面板 fixed 挂 body——视口坐标贴条上沿（原 absolute 语义 bottom:100%+10px），
       * 左缘随条、可视区内夹紧；top 用开启后的实测面板高，避免底部悬空/重叠。 */
      var left = Math.max(8, Math.min(Math.round(cardRect ? cardRect.left : br.left), innerWidth - Math.round(panelWidth) - 8));
      if (panel.style.left !== left + "px") panel.style.left = left + "px";
      var top = Math.max(8, Math.round(anchorTop - panel.offsetHeight - 10));
      if (panel.style.top !== top + "px") panel.style.top = top + "px";
      syncSettingsScroll();
    }
    var previousPanelFocus = null;
    function closeSettings(restoreFocus) {
      panel.classList.remove("open");
      panel.setAttribute("aria-modal", "false");
      gear.setAttribute("aria-expanded", "false");
      if (restoreFocus !== false) {
        var target = previousPanelFocus && previousPanelFocus.isConnected && previousPanelFocus.offsetParent ? previousPanelFocus : null;   // v155：归还目标不可见（如 compact 下的隐藏 gear）不强行 focus
        if (!target && gear.offsetParent) target = gear;
        if (target) { try { target.focus(); } catch (e) { } }
      }
      previousPanelFocus = null;
    }
    panel.addEventListener("scroll", syncSettingsScroll, true);
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeSettings(true);
        e.stopPropagation();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        var nav = panel.querySelector(".zu-settings-nav");
        var buttons = nav ? nav.querySelectorAll(".zu-navitem") : [];
        var current = Array.prototype.indexOf.call(buttons, document.activeElement);
        if (current < 0 || !buttons.length) return;
        if (e.key === "Home") current = 0;
        else if (e.key === "End") current = buttons.length - 1;
        else current = (current + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
        e.preventDefault();
        buttons[current].focus();
      }
    });
    buildPanel();
    /* v80：面板挂 body（fixed 视口坐标），不再挂 bar——条长进输入卡片（overflow-hidden）
     * 内部后，absolute 面板会被卡片裁掉。同 .tip 挂 body 的先例；.zusage-panel 类供
     * 全局清理与 isOwnOverlay 命中。 */
    panel.className = "panel zu-settings zusage-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", L("状态条设置", "Status bar settings"));
    document.body.appendChild(panel);
    /* 子代理统一浮层（v217，原 v49 明细面板节点原位改造）：悬停预览/点击固定共用，
     * 与设置面板同款 .panel 机制 + zusage-panel 全局清理命中；非模态 dialog（同设置面板） */
    var subPanel = document.createElement("div");
    subPanel.className = "panel zu-sub-pop zusage-panel";
    subPanel.setAttribute("role", "dialog");
    subPanel.setAttribute("aria-modal", "false");
    subPanel.setAttribute("aria-label", L("子代理", "Sub-agents"));
    document.body.appendChild(subPanel);
    /* v215：面板内模型行 ? 图标 → 费用说明气泡（复用 fxTip 单例与 tip 同款委托；
     * 仅 data-model 上下文有效，随面板元素移除一并回收，无需独立 dispose） */
    subPanel.addEventListener("mouseover", function (e) {
      var q = e.target && e.target.closest && e.target.closest(".tip-fxq");
      if (q) {
        cancelFxHide();
        var dm = q.getAttribute && q.getAttribute("data-model");
        var info = { type: "default" };
        if (dm) {
          var dr = q.getAttribute("data-rates");
          var parsed = null;
          try { parsed = dr ? JSON.parse(dr) : null; } catch (e1) { parsed = null; }
          var mc = parseInt(q.getAttribute("data-mcount") || "1", 10) || 1;   // v248：汇总 KPI 多模型 → 计价范围
          info = mc > 1
            ? { type: "scope", count: mc, scope: q.getAttribute("data-mscope") || "" }
            : { type: "model", model: dm, rates: parsed };
        }
        showFxTip(q, info);
      }
    });
    subPanel.addEventListener("mouseout", function (e) {
      if (!(e.target && e.target.closest && e.target.closest(".tip-fxq"))) return;
      var to = e.relatedTarget;
      if (to && (to === fxTip || (fxTip.contains && fxTip.contains(to)))) return;
      scheduleFxHide();
    });
    /* 自绘 tooltip：向上弹出（v45 起配空中走廊，移入点击不再被移开即隐掐断）；取代原生 title（方向不可控，在窗口底边会朝下被遮挡） */
    /* 自绘 tooltip 挂 body（fixed 视口坐标）：挂 bar 内会被消息流的层叠上下文盖住（v31 实证） */
    var tip = document.createElement("div");
    tip.className = "tip zusage-tip-root";
    tip.id = slot === 0 ? "zusage-tip" : "zusage-tip-" + slot;
    tip.setAttribute("role", "tooltip");
    tip.style.display = "none";
    document.body.appendChild(tip);
    /* 预估费用 ? 图标 → 说明小气泡（fxTip 模块级单例；mouseover 委托，innerHTML 重建不丢）。
     * mouseout 移入气泡本体时保持（relatedTarget 判定），离开延迟收起（scheduleFxHide）。 */
    tip.addEventListener("mouseover", function (e) {
      var q = e.target && e.target.closest && e.target.closest(".tip-fxq");
      if (q) {
        cancelFxHide();
        /* v214.1 气泡上下文：明细行 icon（data-model）→ 该模型单价；项目卡内 → 项目计价范围；
         * v248 KPI icon 另带 data-mcount>1 → 计价范围行（scope 名词随 data-mscope）。 */
        var info = { type: "default" };
        var inProject = !!(q.closest && q.closest(".zu-project-tip"));
        var dm = q.getAttribute && q.getAttribute("data-model");
        if (dm) {
          /* 单价随 icon 的 data-rates 属性携带（生成时已绑定该行模型），零跨语境查找 */
          var dr = q.getAttribute("data-rates");
          var parsed = null;
          try { parsed = dr ? JSON.parse(dr) : null; } catch (e) { parsed = null; }
          var mc = parseInt(q.getAttribute("data-mcount") || "1", 10) || 1;
          info = mc > 1
            ? { type: "scope", count: mc, scope: q.getAttribute("data-mscope") || "" }
            : { type: "model", model: dm, rates: parsed };
        } else if (inProject) {
          var pjModels = (lastView && lastView.session && lastView.session.project && lastView.session.project.models) || [];
          info = { type: "project", count: pjModels.length };
        }
        showFxTip(q, info);
      }
    });
    /* v214 项目卡展开/收起：局部更新模型区（projTipApplyModels），不整卡重建 */
    /* v275：整卡重编 rAF 合并——快速来回切 Tab 时每次 pointerdown 同步 innerHTML
     * 重建会形成重建风暴（用户实报「快速切换卡死」）；同帧多次切换只重建一次。
     * 切片沙箱无 rAF 自动退回同步（既有测试契约不变）。 */
    var speedRebuildNow = function () {
      if (tipFor && typeof speedTipRebuild === "function") {
        tipFor.__tip = speedTipRebuild(speedChartHover, speedSel);
        drawTip(tipFor, true);
      }
    };
    function scheduleSpeedRebuild() {
      if (speedRebuildPending) return;
      if (typeof requestAnimationFrame !== "function") { speedRebuildNow(); return; }
      speedRebuildPending = requestAnimationFrame(function () {
        speedRebuildPending = 0;
        speedRebuildNow();
      });
    }
    /* v263：Tab 切换共用函数。生成中 updateLive 每 100ms 重编整卡（估算/计时走字让
     * tipSig 每 tick 变化 → innerHTML 重建），mousedown 命中的按钮在 mouseup 前被替换，
     * click 落到共同祖先、closest(".zu-sv-tab") 为 null——用户实报「Tab 点击无效」的根因。
     * pointerdown 在重建窗口之前同步完成切换（此时按钮节点必然存活）；与 click 委托
     * 幂等共存（重建未发生时 click 再跑一遍同值切换无害），键盘 Enter 只发 click 走原路径。 */
    function speedTabActivate(e) {
      /* v273：聚焦/完整时间轴切换按钮（仅改变展示方式，不改统计口径） */
      var fb = e.target && e.target.closest && e.target.closest(".zu-sv-focus");
      if (fb) {
        e.stopPropagation();
        speedSel.focus = speedSel.focus === "full" ? "" : "full";
        speedChartHover = -1; speedInteractAt = Date.now();
        scheduleSpeedRebuild();
        return true;
      }
      var tab = e.target && e.target.closest && e.target.closest(".zu-sv-tab");
      if (!tab) return false;
      e.stopPropagation();
      var grp = tab.getAttribute("data-sv-group"), val = tab.getAttribute("data-sv-val");
      if ((grp === "range" && SPD_RANGES.indexOf(val) >= 0) ||
          (grp === "period" && SPD_PERIODS.indexOf(val) >= 0)) {
        speedSel[grp] = val;
        speedChartHover = -1; speedInteractAt = Date.now();
        /* v272：维度切换移除，dim 恒 time，无需按范围归位 */
        /* v275：重编合并到 rAF——快速连点一帧至多一次整卡重建 */
        scheduleSpeedRebuild();
      }
      return true;
    }
    /* 任何按下交互（含维度 select、柱）都立即进入 600ms 交互冻结：原生下拉展开期间
     * 页面不收 mousemove，若中途重建整卡会销毁展开中的 select——按下即冻结补住这条缝。 */
    /* v275：指针在 tip 内的原生 pointermove 直接保活——mousemove 处理器有 150ms
     * 节流采样盲区，快速移入/静止时 mouseInBar 可能停留 false，left-bar 等 force
     * 路径就能关掉用户正在交互的 tooltip（用户实报「有时候点击 tab 直接关闭」）；
     * pointermove 高频纯赋值无开销，绕开节流盲区让总闸始终可靠。 */
    tip.addEventListener("pointermove", function () {
      mouseInBar = true;
      cancelTipGrace();
    });
    tip.addEventListener("pointerdown", function (e) {
      /* v265：按下即建总闸——快速移动/合成指针下 mousemove 采样可能全部被 150ms
       * 节流丢弃，mouseInBar 停留 false（tooltip 常经 focusin 打开，不经 mousemove），
       * 一次快照推送的 render-orphan 就能关掉正在交互的 tooltip，点击落在消息区。
       * 「指针按在 tip 内」这一事实本身就是最强保活信号，先于一切判定生效。 */
      mouseInBar = true;
      cancelTipGrace();
      lastTipDownAt = Date.now();
      speedInteractAt = Date.now();
      speedTabActivate(e);
    });
    tip.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest && e.target.closest(".zu-pj-more");
      if (btn) {
        e.stopPropagation();
        projTipExpanded = !projTipExpanded;
        projTipApplyModels(btn);
      }
      /* v254 速度 Tooltip 双 Tab：事件委托挂 tip 本体，改实例闭包选择后经
       * speedTipRebuild 整卡重编（签名幂等），旧 hover 卡随筛选切换自动收起。
       * v263：鼠标路径已提前到 pointerdown（见上），此处保留键盘 Enter 与兜底。 */
      speedTabActivate(e);
    });
    /* 项目卡内部 Escape：先收费用说明（fxTip），否则关卡；关闭后焦点归还仍存活的触发项 */
    tip.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (fxTip.style.display === "block") { hideFxTip(); return; }
      var back = tipFor;
      hideTip(true, "escape");
      restoringFocus = true;
      try { if (back && back.focus) back.focus(); } finally { setTimeout(function () { restoringFocus = false; }, 0); }
    });
    tip.addEventListener("mouseout", function (e) {
      if (!(e.target && e.target.closest && e.target.closest(".tip-fxq"))) return;
      var to = e.relatedTarget;
      if (to && (to === fxTip || (fxTip.contains && fxTip.contains(to)))) return;
      scheduleFxHide();
    });
    /* v232 速度柱状图悬停/键盘焦点：委托挂 tip 本体（innerHTML 重建不丢，tip.remove()
     * 随实例消亡、无需进 dispose）。悬停段下标存实例闭包，经 speedTipRebuild 整卡重编
     * （cur 类与信息卡随串自愈 → 数据刷新整卡重建不丢悬停状态）；v240 起 -1/离开=不显示信息卡。 */
    function zuSpeedChartPick(idx) {
      if (idx === speedChartHover) return;
      var hadFocus = tip.contains(document.activeElement) &&
        document.activeElement.closest && document.activeElement.closest(".zu-sc-col");
      speedChartHover = idx; speedInteractAt = Date.now();
      if (tipFor && typeof speedTipRebuild === "function") {
        var t2 = speedTipRebuild(speedChartHover, speedSel);
        if (t2 && tipFor.__tip !== undefined) {
          tipFor.__tip = t2;
          drawTip(tipFor, true);
          /* innerHTML 重建会销毁聚焦的柱节点（焦点落 body、Tab 序断裂）——归位 */
          if (hadFocus && idx >= 0) {
            var nu2 = tip.querySelector('.zu-sc-col[data-i="' + idx + '"]');
            if (nu2 && nu2.focus) nu2.focus();
          }
        }
      }
    }
    tip.addEventListener("mouseover", function (e) {
      var col = e.target && e.target.closest && e.target.closest(".zu-sc-col");
      if (col) zuSpeedChartPick(parseInt(col.getAttribute("data-i"), 10) || 0);
    });
    tip.addEventListener("mouseout", function (e) {
      var col = e.target && e.target.closest && e.target.closest(".zu-sc-col");
      if (!col) return;
      var to = e.relatedTarget;
      /* v242:移入另一根柱时同样交给 mouseover 切段,避免 out(-1)→in(B) 双重整卡重建闪烁 */
      if (to && to.closest && to.closest(".zu-sc-col")) return;
      zuSpeedChartPick(-1);
    });
    tip.addEventListener("focusin", function (e) {
      var col = e.target && e.target.closest && e.target.closest(".zu-sc-col");
      if (col) zuSpeedChartPick(parseInt(col.getAttribute("data-i"), 10) || 0);
    });
    tip.addEventListener("focusout", function (e) {
      var col = e.target && e.target.closest && e.target.closest(".zu-sc-col");
      /* v242:relatedTarget 落在另一根柱上时不得收卡重建——focusout 先于 focusin,
       * 此处重建会销毁即将接收焦点的目标柱(焦点跌落 body、Tab 序断裂) */
      if (col && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".zu-sc-col"))) zuSpeedChartPick(-1);
    });
    bar.appendChild(style);           // 样式随条走，不进 head（防清理）
    /* 内联兜底：即使样式表意外失效，定位行为也不退化。
     * z-index 50：压得过聊天列表/输入框外层容器（Tailwind z-20），又不盖权限菜单等弹层（实测值）。 */
    bar.style.position = "fixed";
    bar.style.zIndex = "50";
    document.body.appendChild(bar);

    /* ---------- 超限告警气泡（v39）：当前会话"上下文超限被拒"时自动弹出，随条定位 ---------- */
    var excBubble = document.createElement("div");
    excBubble.className = "zusage-exc";
    /* 文案只进 textContent/静态 innerHTML；会话 ID 是动态数据，一律走 textContent 防注入。
     * 面板语言切换时 rebuildExcBubble() 重建气泡文案。 */
    var excSid, excCopied;
    function rebuildExcBubble() {
      if (excCopied) clearTimeout(excCopied.timer);
      excBubble.innerHTML =
      '<div class="xb-head"><span class="xb-title">' + L("⚠ 上下文超限", "⚠ Context over limit") + '</span>' +
      '<span class="xb-close" aria-label="' + L("关闭，本次不再提醒", "Close; do not remind again this session") + '">✕</span></div>' +
      '<div class="xb-step">' + L("最近一次请求因超出上下文窗口容量被拒绝，本轮对话暂时无法继续。建议依次尝试：",
        "The latest request was rejected for exceeding the context window; this turn cannot continue for now. Try these in order:") + '</div>' +
      '<div class="xb-step">' + L("① 回滚上一轮对话，去掉超限的那次请求后继续；",
        "① Roll back the previous turn, drop the over-limit request and continue;") + '</div>' +
      '<div class="xb-step">' + L("② 换用上下文窗口更大的模型继续，或压缩 / 精简本会话；",
        "② Continue with a larger-window model, or compress / trim this session;") + '</div>' +
      '<div class="xb-step">' + L("③ 仍无法解决时，新开一个对话，把下面的会话 ID（必要时连同工作区路径）发给它，让新会话读取本会话的记录文件接手修复。",
        "③ If that still fails, start a new conversation and send it the session ID below (workspace path if needed) — the new session can pick up this session's rollout files to take over.") + '</div>' +
      '<div>' + L("会话 ID：", "Session ID: ") + '<span class="xb-sid"></span><span class="xb-copied">' + L("已复制", "Copied") + '</span></div>';
      excSid = excBubble.querySelector(".xb-sid");
      excCopied = excBubble.querySelector(".xb-copied");
      excSid.addEventListener("click", onExcSidCopy);
      excBubble.querySelector(".xb-close").addEventListener("click", onExcClose);
    }
    function onExcSidCopy() {
      if (inactive() || !excSid.textContent) return;
      try {
        var ta = document.createElement("textarea");
        ta.value = excSid.textContent;
        ta.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e) { }
      excCopied.style.display = "inline";
      clearTimeout(excCopied.timer);
      excCopied.timer = setTimeout(function () { excCopied.style.display = "none"; }, 1500);
    }
    function onExcClose() {
      if (inactive()) return;
      excGone = true;
      syncExcBubble();
    }
    rebuildExcBubble();
    document.body.appendChild(excBubble);

    /* ---------- 主题跟随（v58）：深浅由客户端根元素 .dark 类驱动 ----------
     * 客户端主题切换时往 <html> 挂/摘 .dark（zai-dark 时挂；theme-zai-* 同步），整套
     * CSS 变量（--color-background/foreground/border/hover/card/destructive/brand/
     * terminal-* …）随级联翻转，上面的配色自动换装 —— 本块只负责观察 .dark 摘挂，
     * 同步 .zu-light（仅剩阴影/光晕程度性覆盖）。观察类属性而非 matchMedia：
     * 信号源与变量翻转同源，客户端强制浅色+系统深色等错位态不会劈叉。 */
    var rootEl = document.documentElement;
    function themeIsDark() {
      try { return rootEl.classList.contains("dark"); } catch (e) { return true; }
    }
    var themeDark = themeIsDark();
    function applyTheme() {
      bar.classList.toggle("zu-light", !themeDark);
      tip.classList.toggle("zu-light", !themeDark);
      excBubble.classList.toggle("zu-light", !themeDark);
      /* v80：面板挂 body 后不在 bar 的 zu-light 作用域内，自带类（.panel.zu-light） */
      panel.classList.toggle("zu-light", !themeDark);
      subPanel.classList.toggle("zu-light", !themeDark);
      if (mpModalThemeSync) mpModalThemeSync(!themeDark);   // v132：模型拉取弹窗随主题实时换装
    }
    try {
      themeObserver = new MutationObserver(function () {
        var d = themeIsDark();
        if (d !== themeDark) { themeDark = d; applyTheme(); }
        queuePillSurface();
      });
      themeObserver.observe(rootEl, { attributes: true, attributeFilter: ["class", "style"] });
    } catch (e) { }
    applyTheme();

    var $ = function (id) { return bar.querySelector(id); };
    var main = bar.querySelector(".zu-main"), gear = bar.querySelector(".zu-gear");
    /* v172 跨窗口红点收敛：其它窗口 ack 写 zusage3.updSeen 后本实例重算（storage 只在其它窗口触发；
       实例级注册，随 disposeOverlay 的 globalListeners 统一清理） */
    listenGlobal(window, "storage", function (e) {
      if (!e || e.key !== LS.updSeen) return;
      instances.forEach(function (inst) { try { inst.syncUpdate(); } catch (e) { } });
    });

    /* ---------- 渲染 ---------- */
    function fmt(n, count) {
      n = n || 0;
      if (state.forceKmb && !count) {
        // 按原始 token 数四舍五入，避免缩放后的浮点半数偏差。
        if (n >= 1e9) return (Math.round(n / 1e7) / 100).toFixed(2) + "B";
        if (n >= 1e6) return (Math.round(n / 1e4) / 100).toFixed(2) + "M";
        if (n >= 1e3) return (Math.round(n / 100) / 10).toFixed(1) + "K";
        return String(n);
      }
      if (cnUnits()) {
        if (n >= 1e8) return cnUnit(n / 1e8) + "亿";
        if (n >= 1e4) return cnUnit(n / 1e4) + "万";
        return String(n);
      }
      if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(n);
    }
    function countFmt(n) { return fmt(n, true); }
    function cnUnit(x) { return x.toFixed(2).replace(/\.?0+$/, ""); }   // 至多两位小数并去尾零：58.25万、142万、1亿（数字与单位不留空格：等宽字体下空格占满一格）
    function sec(ms) { return ms ? (ms / 1000).toFixed(1) + "s" : "–"; }


    /* 超限判定：最近一次"上下文超限被拒"晚于最近成功请求 = 仍处于超限状态（该请求
     * status=error，不进任何 completed 统计，只能这样单独检测）。html() 与气泡共用。 */
    function excActive(s) {
      return !!(s && s.ctx_exc > 0 && s.ctx_exc >= (s.last_at || 0));
    }

    function cachePct(cache, input) {
      // 无原生 title：原生提示向下弹且与自绘 tooltip 双显闪烁（v33 移除），定义见各项 tooltip 明细
      return input > 0 ? '<span class="dim">' + Math.round(cache / input * 100) + "%</span>" : "";
    }

    /* 档位表（v131 用户规格 2026-10-27）：额度/上下文各五档，按已用百分比判定（含下限不含
     * 上限），从高到低首个命中即档；类名与下方 CSS 手写规则同源（TPS_BANDS 同款纪律）。
     * 额度五档=emerald/sky/amber/orange/rose，上下文五档=slate/indigo/violet/orange/red；
     * 额度 ≥100% 满档（zu-qb-exc）保留 v127 呼吸闪烁特效（用户规格）。 */
    var CTX_BANDS = [
      { min: 90, cls: "crit" },
      { min: 80, cls: "high" },
      { min: 50, cls: "mid" },
      { min: 30, cls: "norm" },
      { min: 0, cls: "calm" },
    ];
    var QUOTA_BANDS = [
      { min: 100, cls: "zu-qb-exc" },
      { min: 90, cls: "zu-qb-crit" },
      { min: 80, cls: "zu-qb-high" },
      { min: 50, cls: "zu-qb-mid" },
      { min: 30, cls: "zu-qb-norm" },
      { min: 0, cls: "zu-qb-calm" },
    ];
    function bandOf(bands, pct) {
      for (var i = 0; i < bands.length; i++) if (pct >= bands[i].min) return bands[i].cls;
      return bands[bands.length - 1].cls;
    }
    /* 上下文分档口径（v93 起唯一消费方是原生按钮增强；原状态条上下文格已删）。
     * cw 优先级：手动覆盖 > 原生按钮 aria-label 读到的总量（nativeCtxVal）> 会话 context_window。
     * 压缩激活（exc）是过程态优先档；v92 百万窗口提前预警（40/60）随统一百分比规格废止。 */
    function ctxBandOf(sess) {
      var cw = parseInt(state.ctxOv, 10) || nativeCtxVal || (sess && sess.context_window) || 0;
      var pct = cw ? (sess && sess.ctx || 0) / cw * 100 : 0;
      var exc = excActive(sess);
      return { cw: cw, pct: pct, cls: exc ? "exc" : bandOf(CTX_BANDS, pct), exc: exc };
    }

    /* 显示顺序：本轮 → 会话 → 工具 → 今日 → 子代理；token 后带缓存命中率。
     * v31：条面只放主数值；悬停改自绘 tooltip（向上弹），随渲染以 tips[]
     * 按 .it 顺序挂到元素 __tip，全部为字符串单页（{tabs:[...]} 多 tab 机制 v49 起
     * 无条目使用已删除：子代理改点击面板，tooltip 不再承载 tab 切换）。
     * 缓存写入/思考/重试/错误均 >0 才显示，0 时不产生噪音。 */
    function fmtTime(ms) {
      var d = ms ? new Date(ms) : null;
      return d ? (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" +
        (d.getMinutes() < 10 ? "0" : "") + d.getMinutes() + ":" +
        (d.getSeconds() < 10 ? "0" : "") + d.getSeconds() : "?";
    }
    function fmtStart(ms) {   // 「最后活动」等非时间范围时间戳：完整日期 YYYY-MM-DD HH:MM（v210 起时间范围行全部改用 fmtStartS）
      if (!ms) return "?";
      var d = new Date(ms);
      function two(v) { return (v < 10 ? "0" : "") + v; }
      return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
        " " + two(d.getHours()) + ":" + two(d.getMinutes());
    }
    function fmtStartS(ms) {   // 时间范围行精确到秒：v166 会话累计/项目累计先行，v210 用户规格扩展到本轮/今日合计与速率 tooltip 最近一段（全部时间范围行统一到秒）
      if (!ms) return "?";
      var d = new Date(ms);
      function two(v) { return (v < 10 ? "0" : "") + v; }
      return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
        " " + two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
    }
    /* v222：速度卡「时间范围」行取值——主数字为会话均/桥态时取会话累计口径
     * （started→last_at，与会话累计 tooltip 同源同款）；「最近一段」回退态取段范围
     * （startedAt→endedAt）。起点缺失视为无有效范围（半程范围无意义），整行不渲染。 */
    function speedSpan(started, ended) {
      return started ? { start: fmtStartS(started), end: ended ? fmtStartS(ended) : "" } : null;
    }
    function ioc(inp, out, cache, rea, cw) {   // 悬停明细行：输入/输出/缓存命中/缓存写入/思考
      return L("输入 ", "Input ") + fmt(inp) + L(" / 输出 ", " / Output ") + fmt(out) + L(" / 缓存命中 ", " / Cache read ") + fmt(cache) +
        (cw > 0 ? L(" / 缓存写入 ", " / Cache write ") + fmt(cw) : "") +
        (rea > 0 ? L(" / 思考 ", " / Thinking ") + fmt(rea) : "");
    }
    /* 结构化 tooltip（v67.1）：\x01 前缀标记 HTML 内容（drawTip 分流），行/脚注排版与
     * 回复末尾统计行 tooltip 同款；动态值一律过 ttEsc（innerHTML 安全，如工具名/错误文案） */
    function ttEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function ttH(t) { return '<div class="rt-h">' + ttEsc(t) + "</div>"; }
    var RT_ATOM_RE = /(?:[¥$]\d[\d,.]*|\b\d[\d,.]*(?:\s*(?:tok\/s|t\/s|tokens?|requests?|calls?|s|ms|次|轮|万|亿|%))(?=$|[\s，；。·（）()]))/g;
    function ttAtomHtml(escaped) { return escaped.replace(RT_ATOM_RE, '<span class="rt-atom">$&</span>'); }
    function ttRow(k, v) {
      return '<div class="rt-row"><b>' + ttEsc(k) + '</b><span>' + ttAtomHtml(ttEsc(v)) + "</span></div>";
    }
    /* v164：吸底行（时间范围）——长明细滚动时固定在滚动视口底缘，内容不足时无异状 */
    function ttRowPin(k, v) {
      return '<div class="rt-row rt-pin"><b>' + ttEsc(k) + '</b><span>' + ttAtomHtml(ttEsc(v)) + "</span></div>";
    }
    function ttNote(v) { return '<div class="rt-note">' + ttEsc(v) + "</div>"; }
    /* ---------- v202 预估费用（USD 快照原值 × 快照 fx 汇率）----------
     * 汇率由 zusage.py 侧 12h 同步（models.dev 牌价 + er-api 汇率），快照只带 USD 原值
     * 与 fx 视图；这里才取整到分。无有效汇率诚实降级 $ 原值，不编造汇率。 */
    function fxRate() {
      var fx = state.data && state.data.fx;
      return (fx && typeof fx.rate === "number" && isFinite(fx.rate) && fx.rate > 0) ? fx.rate : 0;
    }
    function fmtMoney(usd) {
      var rate = fxRate();
      if (rate > 0) {
        var v = usd * rate;
        return (v > 0 && v < 0.01) ? "<¥0.01" : "¥" + v.toFixed(2);
      }
      return (usd > 0 && usd < 0.01) ? "<$0.01" : "$" + usd.toFixed(2);
    }
    /* 费用行：开关关/字段缺失（旧快照、远端旧版）都不渲染，不显假 0。
     * 手拼不走 ttRow——值区要嵌问号 icon（ttEsc 会转义标签）；v202.1 icon 悬停
     * 弹预估费用说明小气泡（fxTip，监听挂 tip 本体 mouseover/out 委托）。 */
    function costTipRow(x) {
      if (!(state.cost && typeof x === "number" && isFinite(x))) return "";
      /* icon 并入同一 rt-atom（inline-block+nowrap）：atom 后跟独立 svg 会被断行
       * 到下一行（实测），整块 nowrap 保「¥X.XX ?」恒同行 */
      return '<div class="rt-row"><b>' + ttEsc(L("预估费用", "Est. cost")) + '</b><span>' +
        '<span class="rt-atom">' + ttEsc(fmtMoney(x)) + FXQ_ICON + "</span></span></div>";
    }
    /* 紧简摘要行的费用尾注（tpsChipTipHTML 四格摘要共用） */
    function costSuffix(x) {
      return (state.cost && typeof x === "number" && isFinite(x)) ? L(" · ", " · ") + fmtMoney(x) : "";
    }
    /* ---------- v214 项目累计统计卡（buildProjectTipHTML）----------
     * 层级：标题与范围 → 三项核心指标 → 用量明细 → 运行规模 → 模型明细表 → 时间范围。
     * 费用完整复用既有链路（pj.cost_usd / m1.cost_usd / fmtMoney，0 是有效金额，缺失显 "—"）。
     * 展开态保存在实例（projTipKey/projTipExpanded），归属键=sid+":"+起始时刻，项目变化自动重置；
     * 展开/收起走局部更新（projTipApplyModels）不重建整卡；数据刷新仍走 tipSig 全量签名。 */
    var projTipKey = "", projTipExpanded = false, projTipList = null;
    function escAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function pjRowsHTML(list, full) {
      var showCost = !!state.cost;   // ⚙ 开关关：费用列整体不渲染（与费用行同语义）
      return list.map(function (m1) {
        var name = m1.model || L("未知模型", "unknown");
        return '<tr>' +
          '<td class="zu-pj-mname"' + (full ? ' title="' + escAttr(name) + '"' : '') + '>' + ttEsc(name) + '</td>' +
          '<td>' + ttEsc(fmt(m1.total || 0)) + '</td>' +
          '<td>' + ttEsc(countFmt(m1.requests || 0)) + '</td>' +
          (showCost ? '<td>' + (typeof m1.cost_usd === "number" && isFinite(m1.cost_usd) ? ttEsc(fmtMoney(m1.cost_usd)) : "—") + '</td>' : "") +
          '</tr>';
      }).join("");
    }
    function pjRowsFor(pj, expanded) {
      /* 上游 _project_usage 已按 total 降序；此处对副本再排序（稳定），不改快照原数组 */
      var list = (pj.models || []).slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); });
      return expanded ? list : list.slice(0, 6);
    }
    function buildProjectTipHTML(pj, ownerKey) {
      projTipKey = ownerKey;
      var expanded = projTipExpanded;
      var fullList = (pj.models || []).slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); });
      projTipList = fullList;
      var shown = expanded ? fullList : fullList.slice(0, 6);
      var hasModels = fullList.length > 0;
      var hitPct = (pj.input > 0 && isFinite(pj.input)) ? Math.round((pj.cache_read || 0) / pj.input * 100) : -1;
      var showCost = !!state.cost;   // ⚙ 开关关：KPI 预估费用格与表头费用列不渲染
      var costV = (typeof pj.cost_usd === "number" && isFinite(pj.cost_usd)) ? fmtMoney(pj.cost_usd) : "—";
      return '<div class="zu-project-tip" data-key="' + escAttr(ownerKey) + '">' +
        '<div class="zu-pj-head"><div class="zu-pj-title' + (pj.name ? " zu-tt-name" : "") + '">' + ttEsc(L("项目累计", "Project total")) +
        (pj.name ? '<span class="zu-pj-pname">' + ttEsc(pj.name) + '</span>' : "") + '</div>' +
        '<div class="zu-pj-range"><span class="zu-pj-scope">' + ttEsc(L("全部请求", "All requests")) + '</span>' +
        '<span class="zu-pj-sub">' + ttEsc(L("含子代理", "incl. sub-agents")) + '</span></div></div>' +
        '<div class="zu-pj-kpis">' +
          '<div class="zu-pj-kpi"><div class="zu-pj-k">' + ttEsc(L("总用量", "Total tokens")) + '</div><div class="zu-pj-v">' + ttEsc(fmt(pj.total || 0)) + '</div></div>' +
          '<div class="zu-pj-kpi"><div class="zu-pj-k">' + ttEsc(L("请求次数", "Requests")) + '</div><div class="zu-pj-v">' + ttEsc(countFmt(pj.requests || 0)) + '</div></div>' +
          (showCost ? '<div class="zu-pj-kpi"><div class="zu-pj-k">' + ttEsc(L("预估费用", "Est. cost")) + FXQ_ICON + '</div><div class="zu-pj-v">' + ttEsc(costV) + '</div></div>' : "") +
        '</div>' +
        '<div class="zu-pj-details">' +
          '<div class="zu-pj-detail"><div class="zu-pj-k">' + ttEsc(L("输入", "Input")) + '</div><div class="zu-pj-dv">' + ttEsc(fmt(pj.input || 0)) + '</div>' +
            '<div class="zu-pj-dsub">' + (hitPct >= 0 ? '<span class="zu-pj-hit">' + ttEsc(L("缓存命中率 ", "cache hit ") + hitPct + "%") + '</span>' : "") + '</div></div>' +
          '<div class="zu-pj-detail"><div class="zu-pj-k">' + ttEsc(L("输出", "Output")) + '</div><div class="zu-pj-dv">' + ttEsc(fmt(pj.output || 0)) + '</div>' +
            '<div class="zu-pj-dsub">' + (pj.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(pj.reasoning)) : "") + '</div></div>' +
          (pj.cache_write > 0
            ? '<div class="zu-pj-detail"><div class="zu-pj-k">' + ttEsc(L("缓存写入", "Cache write")) + '</div><div class="zu-pj-dv">' + ttEsc(fmt(pj.cache_write)) + '</div><div class="zu-pj-dsub"></div></div>'
            : '<div class="zu-pj-detail"></div>') +
        '</div>' +
        '<div class="zu-pj-scale">' +
          '<span>' + ttEsc(countFmt(pj.sessions || 0) + L(" 会话", " sessions")) + '</span><span>·</span>' +
          '<span>' + ttEsc(countFmt(pj.turns || 0) + L(" 轮", " turns")) + '</span><span>·</span>' +
          (pj.tool_calls ? '<span>' + ttEsc(L("工具 ", "tools ") + countFmt(pj.tool_calls) + L(" 次", " calls")) + '</span><span>·</span>' : "") +
          (pj.retries ? '<span>' + ttEsc(L("重试 ", "retries ") + countFmt(pj.retries) + L(" 次", " times")) + '</span>' : "") +
        '</div>' +
        (hasModels
          ? '<div class="zu-pj-models"><div class="zu-pj-mhead"><div class="zu-pj-mtitle">' + ttEsc(L("模型明细", "Models")) + '</div>' +
            '<div class="zu-pj-morder">' + ttEsc(L("按用量排序", "by usage")) + '</div></div>' +
            '<table class="zu-pj-table"><thead><tr><th>' + ttEsc(L("模型", "Model")) + '</th>' +
            '<th>' + ttEsc(L("Token 用量 ↓", "Tokens ↓")) + '</th><th>' + ttEsc(L("请求次数", "Requests")) + '</th>' +
            (showCost ? '<th>' + ttEsc(L("预估费用", "Est. cost")) + '</th>' : "") + '</tr></thead>' +
            '<tbody data-zu-pj-rows>' + pjRowsHTML(shown, true) + '</tbody></table>' +
            (fullList.length > 6
              ? '<button type="button" class="zu-pj-more" data-key="' + escAttr(ownerKey) + '" aria-expanded="' + (expanded ? "true" : "false") + '" aria-controls="zu-pj-rows">' +
                (expanded ? ttEsc(L("收起", "Show less")) : ttEsc(L("查看全部 " + fullList.length + " 个模型", "Show all " + fullList.length + " models")) + ' ▾') + '</button>'
              : "") +
            '</div>'
          : "") +
        '<div class="zu-pj-time"><b>' + ttEsc(L("时间范围", "Time span")) + '</b>' +
        '<span>' + (pj.started ? fmtStartS(pj.started) : "—") + " — " + (pj.last_at ? fmtStartS(pj.last_at) : "—") + '</span></div>' +
        '</div>';
    }
    /* 展开/收起的局部更新：只替换模型行与按钮态，不重建整卡（滚动/焦点/选择不受扰）。
     * 内容串纳入 expanded 态，数据刷新整卡重建时保持展开；归属键不匹配则忽略。 */
    function projTipApplyModels(btn) {
      var root = btn.closest && btn.closest(".zu-project-tip");
      if (!root || btn.getAttribute("data-key") !== projTipKey) return;
      var shown = projTipExpanded ? projTipList : projTipList.slice(0, 6);
      var rows = root.querySelector("[data-zu-pj-rows]");
      if (rows) rows.innerHTML = pjRowsHTML(shown, true);
      btn.setAttribute("aria-expanded", projTipExpanded ? "true" : "false");
      btn.innerHTML = projTipExpanded
        ? ttEsc(L("收起", "Show less"))
        : ttEsc(L("查看全部 " + projTipList.length + " 个模型", "Show all " + projTipList.length + " models")) + " ▾";
      if (typeof positionTip === "function" && tipFor) positionTip(tipFor, true);
    }
    /* v215 统计卡公共片段（六卡共用）：head/KPI/明细/规模/表格/时间。数据全部真实字段。 */
    function statHead(title, scope, name) {
      /* v230.1 名称与标题垂直居中：带名称时标题容器切 flex，名称作为子项中心对齐 */
      return '<div class="zu-stat-head"><div class="zu-stat-title' + (name ? " zu-tt-name" : "") + '">' + ttEsc(title) +
        (name || "") + '</div>' +
        (scope ? '<div class="zu-stat-scope">' + ttEsc(scope) + '</div>' : "") + '</div>';
    }
    function statKpi(k, vHtml, extraCls) {
      return '<div class="zu-stat-kpi' + (extraCls ? " " + extraCls : "") + '"><div class="zu-stat-k">' + k + '</div><div class="zu-stat-v">' + vHtml + '</div></div>';
    }
    function statDetail(k, dv, sub) {
      return '<div class="zu-pj-detail"><div class="zu-pj-k">' + ttEsc(k) + '</div><div class="zu-stat-dv">' + ttEsc(dv) + '</div>' +
        (sub ? '<div class="zu-stat-dsub">' + sub + '</div>' : '<div class="zu-stat-dsub"></div>') + '</div>';
    }
    function statTime(started, ended) {
      return '<div class="zu-pj-time"><b>' + ttEsc(L("时间范围", "Time span")) + '</b><span>' +
        (started ? fmtStartS(started) : "—") + " — " + (ended ? fmtStartS(ended) : "—") + '</span></div>';
    }
    function statTable(headers, rowsHtml) {
      return '<table class="zu-stat-table"><thead><tr>' + headers.map(function (h) { return '<th>' + ttEsc(h) + '</th>'; }).join("") + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>';
    }
    function hitPctOf(read, cached) {
      return (read > 0 && isFinite(read)) ? Math.round((cached || 0) / read * 100) : -1;
    }
    /* v202 本轮/今日 tooltip 的模型明细块（与会话/项目 rt-models 同构：token·次数·费用·?） */
    function modelsBlock(models) {
      return (models && models.length)
        ? '<div class="rt-models">' + models.map(function (m1) {
            return '<div class="rt-row"><b>' + ttEsc(m1.model || L("未知模型", "unknown")) + '</b><span>' +
              ttEsc(fmt(m1.total) + L(" token · ", " token · ") + countFmt(m1.requests || 0) + L("次", " req") +
                (state.cost && typeof m1.cost_usd === "number" ? L(" · ", " · ") + fmtMoney(m1.cost_usd) : "")) +
              (state.cost && typeof m1.cost_usd === "number" ? FXQ_ICON.replace('class="tip-fxq"', 'class="tip-fxq" data-model="' + escAttr(m1.model || "") + '"' + (m1.rates ? ' data-rates="' + escAttr(JSON.stringify(m1.rates)) + '"' : "")) : "") + "</span></div>";
          }).join("") + "</div>"
        : "";
    }
    /* v253 本轮/今日合计 tooltip 的「模型明细」表格（样式同项目累计/会话累计统计卡：
     * zu-pj-mhead 标题 + 四列 zu-stat-table；数据同源 _scope_models_cost 已降序，
     * 此处对副本防御性重排不改快照原数组；费用列随 state.cost 门控、缺失显 "—"；
     * 空明细/旧快照缺字段整块不渲染。精简摘要的 rt-models 行式（modelsBlock）保留。 */
    function statModelsTable(models) {
      if (!models || !models.length) return "";
      var heads = [L("模型", "Model"), L("Token 用量 ↓", "Tokens ↓"), L("请求次数", "Requests")];
      if (state.cost) heads.push(L("预估费用", "Est. cost"));
      return '<div class="zu-pj-mhead"><div class="zu-pj-mtitle">' + ttEsc(L("模型明细", "Models")) + '</div><div class="zu-pj-morder">' + ttEsc(L("按用量排序", "by usage")) + '</div></div>' +
        statTable(heads, models.slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); }).map(function (m1) {
          var name = m1.model || L("未知模型", "unknown");
          return '<tr>' +
            '<td class="zu-pj-mname" title="' + escAttr(name) + '">' + ttEsc(name) + '</td>' +
            '<td>' + ttEsc(fmt(m1.total || 0)) + '</td>' +
            '<td>' + ttEsc(countFmt(m1.requests || 0)) + '</td>' +
            (state.cost ? '<td>' + (typeof m1.cost_usd === "number" && isFinite(m1.cost_usd) ? ttEsc(fmtMoney(m1.cost_usd)) : "—") + '</td>' : "") +
            '</tr>';
        }).join(""));
    }
    /* v248：KPI 费用 ? 图标随卡携带模型上下文——data-model/data-rates=按用量最多模型、
     * data-mcount=模型数、data-mscope=计价范围名词（气泡多模型时显示「计价范围」行）。
     * 不再借快照根部 last（全局最近会话的模型，悬浮会话≠它时张冠李戴）；
     * 无模型明细（轻量行/旧快照/远端旧行）退回裸图标=气泡不显模型行。 */
    function fxqIcon(models, scopeText) {
      var ms = (models && models.length) ? models : null;
      if (!ms) return FXQ_ICON;
      var top = ms.slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); })[0] || {};
      return FXQ_ICON.replace('class="tip-fxq"', 'class="tip-fxq" data-model="' + escAttr(top.model || "") + '"' +
        (top.rates ? ' data-rates="' + escAttr(JSON.stringify(top.rates)) + '"' : "") +
        ' data-mcount="' + ms.length + '"' +
        (scopeText ? ' data-mscope="' + escAttr(scopeText) + '"' : ""));
    }
    /* v97：live chip（生成速度）的 tooltip 内容——子代理速率是渲染端实时状态（不在泵
     * 快照里），html() 整条渲染与 updateLive 原地改字两条路径都要能生成，抽出共用。
     * 运行中的每个子代理一行（…sid4 · 估 X t/s），并行 ≥2 个时先给合计行。 */
    function buildLiveTip(speedView) {
      /* v215 速度统计卡 live 态：scope=生成中估算；主读数=状态词/估算值（speedView.cls
       * 档位色）；sub=最近一轮真实值。保留子代理槽位明细与两侧口径说明（各自真实口径）。
       * v232：快照带 speed_segs 时右列改画「最近 17 段」柱状图（最近一段由最新柱承载，
       * sub 右格只在无图表的旧快照回退布局保留），柱级悬停/焦点经 speedTipRebuild 重建。 */
      var isTool = speedView && speedView.phase === "tool";
      var isThink = speedView && speedView.phase === "thinking";
      var mainText = speedView ? speedView.text : "—";
      var mainCls = speedView && speedView.cls ? speedView.cls : "";
      var noUnit = isTool || isThink || !speedView || typeof speedView.rate !== "number";
      var segs = speedSegsOf(lastView && lastView.session);
      var hasChart = !!(segs && segs.length);
      var segSess = (lastView && lastView.session && lastView.session.sid) || "";
      if (speedTipSess !== segSess) {   // 会话切换：v240 起回未悬停；v254 筛选态一并复位，不串上一 pane 的选择
        speedTipSess = segSess; speedChartHover = -1;
        if (typeof speedSel !== "undefined" && speedSel) {
          speedSel.range = "recent"; speedSel.period = "recent"; speedSel.dim = "time"; speedSel.focus = "";
        }
      }
      /* v218 修复：zuBarSpeedView 从不返回 latest 字段，右格恒缺（用户实测「缺少最近
       * 一段的生成速度」）。改取泵快照最近一段真实值（last.tps，与 fallback 完成态
       * 右格同口径、同文案「最近一段」）。v232：有图表时该读数由最新柱承载。 */
      var subLabel = "", subVal = "";
      var dbTps3 = (lastView && lastView.last && typeof lastView.last.tps === "number" &&
        isFinite(lastView.last.tps) && lastView.last.tps > 0) ? lastView.last.tps : 0;
      if (dbTps3 && !hasChart) {
        subLabel = L("最近一段", "Latest segment");
        subVal = (dbTps3 % 1 ? dbTps3.toFixed(1) : String(dbTps3));
      }
      /* v222：时间范围行取会话累计口径（lastView.session，与会话累计 tooltip 同源）；
       * 会话起点缺失（远端轻量行/旧快照）整行不渲染。 */
      var liveSpan = speedSpan(lastView && lastView.session ? lastView.session.started : 0,
                               lastView && lastView.session ? lastView.session.last_at : 0);
      var basisText = [];
      if (speedView && speedView.phase) {
        basisText.push(L("按文本增量算出的字符/s，除以「每 token 字符数」估算 tok/s；该比例取自本会话最近一次完成的真实轮次，随每轮刷新（首轮无样本时用粗略默认值）",
          "estimated from the text-delta chars/s divided by a chars-per-token ratio; the ratio is calibrated from this session's most recently completed turn and refines each turn (a rough default is used before the first sample)"));
        basisText.push(L("子智能体运行期间按各自会话文本增量同款估算，主 chip 显示合计；运行中的请求未入本地库，思考文本不外显时无速率、只显示状态词",
          "while sub-agents run, each is estimated the same way from its own session text deltas and the bar chip shows their sum; in-flight requests are not in the local DB yet, and when thinking text is not exposed there is no rate, only the status word"));
      } else {
        basisText.push(speedView && speedView.kind === "avg"
          ? L("Σ输出（含思考）÷ 生成耗时", "Σoutput (thinking incl.) ÷ generation time")
          : L("本轮完成 · 真实值：输出 tokens（含思考）÷ 模型生成时长；本轮缺口径时回退数据库最近一段值",
          "Turn completed · actual: output tokens (thinking incl.) ÷ model generation time; falls back to the latest DB segment when this turn's basis is missing"));
      }
      if (hasChart) {
        basisText.push(L("最近 10 轮：每轮（一次提问的全部模型请求）按 Σ有效输出 ÷ Σ生成耗时加权的真实速度，按完成顺序从旧到新展示；工具等待不计，不含子代理。",
          "Last 10 turns: weighted real speed of each completed turn (all its model requests, Σrated output ÷ Σgeneration time), oldest → newest; tool waits excluded, sub-agents excluded."));
      }
      function extraHtml() {
        var out = "";
        if (isTool) {
          var sids = [], now = Date.now();
          for (var sid in subRate.slots) sids.push(sid);
          sids.sort();
          var fresh = 0;
          for (var i = 0; i < sids.length; i++) {
            var sl = subRate.slots[sids[i]];
            if (sl.rate != null && now - sl.at <= 3000) fresh++;
          }
          if (sids.length) {
            if (fresh > 1) out += '<div class="zu-stat-note">' + escHtml(L("合计 估 ", "Sum est ") + subRate.sum.rate.toFixed(1) + L(" t/s（", " t/s (") + fresh + L(" 个）", " running)")) + '</div>';
            for (var j = 0; j < sids.length; j++) {
              var s2 = subRate.slots[sids[j]];
              var tail = String(sids[j]).slice(-4);
              out += '<div class="zu-stat-note">' + escHtml(L("子代理 …" + tail + " ", "agent …" + tail + " ") +
                (s2.rate != null && now - s2.at <= 3000 ? L("估 ", "est ") + s2.rate.toFixed(1) + L(" t/s", " t/s") : L("估算中…", "estimating…"))) + '</div>';
            }
          }
        }
        return out;
      }
      var foot = [L("数据来自 renderer 会话状态（只读桥），实时更新，不经过本地数据库轮询；生成中的数值为字符增量估算", "Data comes from the renderer session state via the read-only bridge, updating live, independent of local database polling; running values are estimated from text deltas")];
      /* v235：结构化状态直传（zuBarSpeedView 的 kind/statusText/…），思考态注入脑图标；
       * scope 标签按真实状态映射，不再一律写「生成中估算」——完成态标会话平均/本轮
       * 真实速度，工具/组/Skill/子代理/思考各归其位。 */
      var liveScopeMap = {
        tool: L("工具执行中", "Tool running"),
        toolgroup: L("工具组执行中", "Tool group running"),
        skill: L("Skill 执行中", "Skill running"),
        subagent: L("子代理运行中", "Sub-agents running"),
        thinking: L("思考中", "Thinking"),
        estimate: L("生成中（估算）", "Generating (est.)"),
        avg: L("会话平均", "Session average"),
        real: L("本轮实际速度", "Actual speed this turn")
      };
      var liveScope = speedView && speedView.kind && liveScopeMap[speedView.kind]
        ? liveScopeMap[speedView.kind]
        : (speedView && speedView.phase ? L("生成中估算", "Running estimate") : L("本轮完成 · 真实值", "Turn completed · actual"));
      var liveStatus = null;
      if (speedView && speedView.kind) {
        liveStatus = speedView;
        if (speedView.kind === "thinking") liveStatus.iconHTML = zuIcoThinking();
      }
      var opts = {
        scope: liveScope,
        status: liveStatus,
        main: mainText,
        mainCls: mainCls,
        noUnit: noUnit,
        subLabel: subLabel,
        sub: subVal,
        bandTag: speedView && speedView.band ? tpsBandText(speedView.band) : "",
        curCls: speedView && speedView.band ? speedView.cls : "",
        basisTitle: L("统计口径", "Basis"),
        basisText: basisText,
        timeStart: liveSpan ? liveSpan.start : "",
        timeEnd: liveSpan ? liveSpan.end : "",
        foot: foot,
        segs: segs,
        segsHover: speedChartHover,
        /* v250：悬停信息卡轮明细的格式化回调（bandHelpers 切片不可达本闭包）；费用行
         * 随 state.cost 门控（关时不传 fmtMoney → 明细行不带预估费用） */
        fmtTok: fmt,
        fmtCnt: countFmt,
        fmtMoney: state.cost ? fmtMoney : null
      };
      /* v232：柱级悬停/焦点改悬停段下标后经此闭包整卡重建（串里已带 cur/信息卡状态，
       * 与 updateLive 每写回 __tip 的链路同源；下一 tick 的 buildLiveTip 会覆盖闭包）。 */
      var v2selL = (typeof speedSel !== "undefined" && speedSel) ? speedSel
        : { range: "recent", period: "recent", dim: "time" };
      /* v268：帧缺轮表（serve 重启窗口）时以粘性兜底，杜绝 V2↔旧版闪回 */
      var v2h = (state.data && state.data.speed_history) ||
        (typeof lastSpeedHistory !== "undefined" && lastSpeedHistory) || null;
      var v2sess = (lastView && lastView.session) || {};
      speedTipRebuild = (typeof spdRebuildOr === "function"
        ? spdRebuildOr(v2h, v2selL, speedChartHover, speedView,
          { fmtTok: fmt, fmtCnt: countFmt, fmtMoney: state.cost ? fmtMoney : null }, v2sess) : null);
      /* v258 帧级诊断：V2 成功/回退各记一条 spdTip——再出现「样式变回旧版」时 diag 直接
       * 给出走哪条路径与当时轮表长度，不再靠截图反推。原地更新属性，不替换 FATAL 本体。
       * v261：spdTip 带 pane 标识（多实例共享 diag，无标识无法分清是哪个实例写的）。 */
      if (speedTipRebuild) {
        try { FATAL.spdTip = { t: Date.now(), src: "v2-live", pane: pid,
          turns: v2h && v2h.turns ? v2h.turns.length : -1 }; } catch (_) { }
      } else {
        try { FATAL.spdTip = { t: Date.now(), src: "fb-live", pane: pid,
          turns: v2h && v2h.turns ? v2h.turns.length : -1,
          range: v2selL && v2selL.range, period: v2selL && v2selL.period,
          sid: String((v2sess && v2sess.sid) || "").slice(-8) }; } catch (_) { }
        speedTipRebuild = function () {
          opts.segsHover = speedChartHover;
          return '\x01' + speedCardHTML(opts) + extraHtml() + '</div>';
        };
      }
      return speedTipRebuild(speedChartHover, v2selL);
      function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    }
    /* 行内 SVG 线性图标（v54）：stroke 走 currentColor，颜色由 .ico 控制统一换色 */
    function ico(paths) {
      return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    }
    function html(d) {
      var sess = d.session || {}, lt = d.last_turn || {}, today = d.today || {}, last = d.last || {};
      var tls = d.tools || { total: 0, errors: 0, list: [] };
      var items = [], tips = [];
      function it(inner, tipContent, cls) {
        var interactive = cls === "zu-sub";
        items.push('<' + (interactive
          ? 'button type="button" aria-label="' + L("子代理", "Sub-agents") + '"'
          : 'span tabindex="0"') +
          ' class="it' + (cls ? " " + cls : "") + '">' + inner + (interactive ? "</button>" : "</span>"));
        tips.push(tipContent || null);
      }
      if (d.remote) {   // v9：SSH 远程会话（数据取自远端机），置顶徽标标明数据源
        it(ico('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>') +
          '<span class="dim">' + L("远端", "remote") + "</span>",
          L("数据源：SSH 远程服务器 ", "Data source: remote server over SSH ") + (d.remote_host || "?") + "\n" +
          L("会话数据实时取自远端机的 ZCode 数据库，「今日合计」亦为远端值", "Session data is fetched live from the remote machine's ZCode database; today's total is the remote value") +
          (d.remote_error ? "\n⚠ " + L("最近一次远端查询失败：", "Last remote query failed: ") + d.remote_error : "") +
          (d.remote_stale ? "\n" + L("当前显示最后成功快照，正在重试", "Showing last successful snapshot; retrying") : "") +
          (d.remote_empty ? "\n⚠ " + L("远端库里这个会话还没有已完成的请求（各项为 0）——确认远端 zusage.py 读到的库与远端 ZCode 实际写入的库是同一个",
                                        "The remote database has no completed requests for this session (all items are 0) — check that the remote zusage.py reads the same database the remote ZCode actually writes") : ""));
      }
      if (d.not_local) {   // v62（issue #14）：本地库没有这个会话 —— 全 0 不是插件坏了，是数据不在这儿
        it(ico('<circle cx="12" cy="12" r="9"/><path d="M12 16h.01"/><path d="M12 8h.01"/>') +
          '<span class="dim">' + L("不在本地库", "not in local db") + "</span>",
          L("这个会话不在本地数据库里（~/.zcode/cli/db/db.sqlite 查不到它），所以各项显示 0 —— 不是插件坏了。",
            "This session is not in the local database (~/.zcode/cli/db/db.sqlite), which is why every item reads 0 — the plugin is not broken.") + "\n" +
          (d.remote_enabled
            ? L("已配置 remote 段，但远端查询没有返回它：", "A remote section is configured, but the remote query did not return it: ")
              + (d.remote_error ? L("查询失败 ", "query failed: ") + d.remote_error
                 : L("远端库里也没有这个会话（核对远端 zusage.py 读的库/用户与远端 ZCode 实际写入的是否一致）",
                     "the remote database does not have it either (verify the database/user the remote zusage.py reads matches what the remote ZCode writes)"))
            : L("若这是 SSH/WSL 远程会话：客户端连过的远端工作区会自动被发现并查询（零配置）；没查到时核对远端已部署 zusage.py（WSL 需发行版内有 python3），或在 config.json 配置 remote 段（README「远程会话」；ssh 也可写成 argv 数组，docker exec / wsl --exec / kubectl exec 等通道都能借道）",
                "If this is a remote SSH/WSL session: remote workspaces the client connected to are discovered and queried automatically (zero config); if it's still missing, make sure zusage.py is deployed on the remote machine (WSL needs python3 inside the distro), or add the remote section to config.json (see README; ssh may also be an argv array, so docker exec / wsl --exec / kubectl exec all work)")));
      }
      /* v73：生成速度——桥命中（本 pane 会话有 renderer 投影）时用它的估算/真实 tok/s，
       * 否则退回原 DB 最近一段值（与 state.rateLine 开关无关：桥不可用或开关关闭时
       * liveStatsCur 恒为空，自动走 db 分支，不影响这个本就独立于逐问速率行的指标）。
       * zuBarSpeedView 对"刚绑定/重绑时捞到的历史存量已完成轮次"返回 null——这种情况
       * 和"桥完全没命中"一视同仁，同样回退 DB/不渲染，不冒充"这个会话速度不可用"。
       * 二者互斥：绝不同时渲染两枚「速度」chip。 */
      var dbTps = last.tps || 0;
      var sessAvg = (sess && typeof sess.avg_tps === "number" && isFinite(sess.avg_tps) && sess.avg_tps > 0) ? sess.avg_tps : 0;
      var speedView = liveStatsCur ? zuBarSpeedView(liveStatsCur, bridge.handle && bridge.handle.charsPerToken, subRate.sum, sessAvg) : null;
      if (speedView) {
        liveKindCur = "live";
        livePhaseCur = speedView.phase || "";
        liveIconCur = speedView.phase === "thinking" ? "think" : speedView.phase === "tool" ? "tool" : speedView.phase ? "generate" : "bolt";
        it((speedView.phase === "thinking" ? zuIcoThinking()
          : speedView.phase === "tool" ? ico('<path d="M14.5 2.5a6 6 0 0 0-5.6 8.1L3.3 16.2a3.2 3.2 0 0 0 4.5 4.5l5.6-5.6a6 6 0 0 0 8.1-5.6l-4.1 3-3.8-3.8 3-4.1a6 6 0 0 0-2.1-2.1z"/>')
          : ico('<path d="M13.5 2 3.5 13.5H11L10 22l10.5-12H13l.5-8z"/>')) +
          '<span class="zu-live ' + speedView.cls + (speedView.word ? " zu-shimmer" : "") + '">' + ttEsc(speedView.text) + "</span>",
          buildLiveTip(speedView));
      } else if ((sessAvg || dbTps) && isFinite(sessAvg || dbTps) && (sessAvg || dbTps) > 0) {
        /* v127：负数/±Infinity 是异常数据，按无数据处理（整枚 chip 不渲染，与
         * NaN/0 一致），绝不判成低速；正有限值按 TPS_BANDS 分档，档位行动态显示。
         * 有会话平均时主数字 = 会话平均（与桥完成态同口径），最近一段退到 tooltip。 */
        liveKindCur = "fallback";
        livePhaseCur = "";
        liveIconCur = "bolt";
        var mainTps = sessAvg || dbTps;
        var tband = tpsBand(mainTps);
        var speedTm = sessAvg ? speedSpan(sess.started, sess.last_at) : speedSpan(last.startedAt, last.endedAt);   // v222 时间范围行
        /* v232：最近 17 段柱状图（快照 speed_segs，Python 侧 avg_tps 同款口径）。
         * 会话切换重置悬停段；有图表时「最近一段」右格由最新柱承载。 */
        var fbSegs = speedSegsOf(sess);
        var fbHasChart = !!(fbSegs && fbSegs.length);
        var fbSess = sess.sid || "";
        if (speedTipSess !== fbSess) {
          speedTipSess = fbSess; speedChartHover = -1;
          if (typeof speedSel !== "undefined" && speedSel) {
          speedSel.range = "recent"; speedSel.period = "recent"; speedSel.dim = "time"; speedSel.focus = "";
        }
        }
        var fbBasis = sessAvg
          ? [L("Σ输出（含思考）÷ 生成耗时", "Σoutput (thinking incl.) ÷ generation time")]
          : [L("输出 tokens（含思考）÷ 生成耗时", "output tokens (thinking incl.) ÷ generation time")];
        if (fbHasChart) {
          fbBasis.push(L("最近 10 轮：每轮（一次提问的全部模型请求）按 Σ有效输出 ÷ Σ生成耗时加权的真实速度，按完成顺序从旧到新展示；工具等待不计，不含子代理。",
            "Last 10 turns: weighted real speed of each completed turn (all its model requests, Σrated output ÷ Σgeneration time), oldest → newest; tool waits excluded, sub-agents excluded."));
        }
        var fbFoot = [L("每段完成后刷新：回复末尾为整问加权均值，数值不同属正常。", "Refreshes as each segment completes: the reply-end line is the whole-turn weighted average and legitimately differs.")];
        var fbOpts = {
          scope: sessAvg ? L("会话平均", "Session average") : L("最近一段", "Latest segment"),
          status: { kind: sessAvg ? "avg" : "real",
            statusText: L("生成完成", "Generation complete"),
            speedValue: mainTps, speedIsEstimated: false,
            speedSource: sessAvg ? "avg" : "real", band: tband,
            noteText: sessAvg ? L("会话加权平均", "Weighted average")
              : L("最近一段 · 实际值", "Latest segment · actual") },
          main: (mainTps % 1 ? mainTps.toFixed(1) : String(mainTps)),
          mainCls: tband.cls,
          subLabel: (!fbHasChart && sessAvg && dbTps > 0) ? L("最近一段", "Latest segment") : "",
          sub: (!fbHasChart && sessAvg && dbTps > 0) ? (dbTps % 1 ? dbTps.toFixed(1) : String(dbTps)) : "",
          bandTag: tpsBandText(tband),
          curCls: tband.cls,
          basisTitle: L("统计口径", "Basis"),
          basisText: fbBasis,
          foot: fbFoot,
          timeStart: speedTm ? speedTm.start : "",
          timeEnd: speedTm ? speedTm.end : "",
          segs: fbSegs,
          segsHover: speedChartHover,
          fmtTok: fmt,
          fmtCnt: countFmt,
          fmtMoney: state.cost ? fmtMoney : null   // v250：悬停卡轮明细格式化回调（费用随 state.cost 门控）
        };
        /* v254：有统一轮表时整卡改走 V2（筛选/16 柱/五字段 hover），旧快照回退原布局。
         * 用纯函数桥 spdRebuildOr（切片夹具内也可达）；speedSel 在 VM 夹具里不存在时
         * 按默认筛选，不影响旧契约断言。 */
        var v2sel = (typeof speedSel !== "undefined" && speedSel) ? speedSel
          : { range: "recent", period: "recent", dim: "time" };
        var v2fn = (typeof spdRebuildOr === "function"
          ? spdRebuildOr(d.speed_history ||
            (typeof lastSpeedHistory !== "undefined" && lastSpeedHistory), v2sel, speedChartHover, null,
            { fmtTok: fmt, fmtCnt: countFmt, fmtMoney: state.cost ? fmtMoney : null }, sess) : null);
        /* v261：整条渲染专记 spdRender（updateLive 每 tick 的 v2-live 会覆盖 spdTip，
         * 用户 hover 瞬间的整条渲染记录必须独立存活）；带 pane/会话标识与分支原因。 */
        var spdSID8 = String(sess.sid || "").slice(-8);
        if (v2fn) {
          try { FATAL.spdRender = { t: Date.now(), src: "v2-html", pane: pid, sid: spdSID8,
            turns: d.speed_history && d.speed_history.turns ? d.speed_history.turns.length : -1,
            range: v2sel.range, period: v2sel.period, dim: v2sel.dim }; } catch (_) { }
          speedTipRebuild = v2fn;
        } else {
          try { FATAL.spdRender = { t: Date.now(), src: "fb-html", pane: pid, sid: spdSID8,
            turns: d.speed_history && d.speed_history.turns ? d.speed_history.turns.length : -1,
            hasH: !!d.speed_history, range: v2sel.range, period: v2sel.period }; } catch (_) { }
          try { FATAL.spdTip = { t: Date.now(), src: "fb-html", pane: pid,
            turns: d.speed_history && d.speed_history.turns ? d.speed_history.turns.length : -1,
            range: v2sel.range, period: v2sel.period, sid: String(sess.sid || "").slice(-8) }; } catch (_) { }
          speedTipRebuild = function () {
            fbOpts.segsHover = speedChartHover;
            return "\x01" + speedCardHTML(fbOpts);
          };
        }
        it(ico('<path d="M13.5 2 3.5 13.5H11L10 22l10.5-12H13l.5-8z"/>') +
          (sessAvg ? '<span class="dim">' + L("均", "avg ") + '</span>' : "") +
          '<span class="zu-live ' + tband.cls + '">' + (mainTps % 1 ? mainTps.toFixed(1) : String(mainTps)) + '</span><span class="dim">t/s</span>',   /* v226：去「· 近X」尾缀（用户规格），最近一段只在 tooltip */
          speedTipRebuild(speedChartHover, v2sel));
      } else {
        liveKindCur = "none";
        livePhaseCur = "";
        liveIconCur = "";
      }
      if (state.show.turn) {
        it(ico('<path d="M5 3.5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9l-6.5 4V5.5a2 2 0 0 1 1.5-2z"/><path d="M7.5 8.5h9m-9 4h6"/>') +
          '<span class="v">' + fmt(lt.total) + "</span>" +
          (state.theme === "pill" ? "" :
            (shrink ? "" : cachePct(lt.cache_read, lt.input)) +
            '<span class="dim">' + countFmt(lt.requests || 0) + L("次", " req") + "</span>"),
          /* v211 格面移除单次耗时/首字延迟段（用户规格）：耗时/延迟只在 tooltip 呈现
           * （平均耗时/平均延迟，对全体请求求均值） */
          "\x01" +
          '<div class="zu-stat-tip zu-stat-tip--turn">' +
          statHead(L("本轮", "Latest turn"), countFmt(lt.requests || 0) + L(" 次请求", " requests")) +
          '<div class="zu-stat-kpis">' +
            statKpi(L("总用量", "Total tokens"), ttEsc(fmt(lt.total || 0))) +
            ((typeof lt.tps === "number" && isFinite(lt.tps) && lt.tps > 0)
              ? statKpi(L("输出速度", "Output rate"), ttEsc(lt.tps.toFixed(1)) + ' <small>t/s</small>')
              : statKpi(L("输出速度", "Output rate"), "—")) +
            ((state.cost && typeof lt.cost_usd === "number" && isFinite(lt.cost_usd))
              ? statKpi(L("预估费用", "Est. cost") + fxqIcon(lt.models, L("本轮", "this turn")), ttEsc(fmtMoney(lt.cost_usd)))
              : "") +
          '</div>' +
          '<div class="zu-stat-grid2">' +
            statDetail(L("输入", "Input"), fmt(lt.input || 0),
              (hitPctOf(lt.input, lt.cache_read) >= 0 ? '<span class="hit">' + ttEsc(L("缓存命中率 ", "cache hit ") + hitPctOf(lt.input, lt.cache_read) + "%") + '</span>' : "")) +
            statDetail(L("输出", "Output"), fmt(lt.output || 0),
              (lt.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(lt.reasoning)) : "")) +
          '</div>' +
          ((lt.avg_duration_ms > 0 || lt.avg_ttft_ms > 0 || lt.duration_ms > 0)
            ? '<div class="zu-stat-kpis zu-stat-kpis--sub">' +
              (lt.avg_duration_ms > 0 ? statKpi(L("平均耗时", "Avg time"), ttEsc(sec(lt.avg_duration_ms))) : "") +
              (lt.avg_ttft_ms > 0 ? statKpi(L("平均延迟", "Avg TTFT"), ttEsc(sec(lt.avg_ttft_ms))) : "") +
              (lt.duration_ms > 0 ? statKpi(L("本轮总耗时", "Turn time"), ttEsc(sec(lt.duration_ms))) : "") +
              '</div>' : "") +
          ((lt.tool_calls || lt.retries || lt.tool_errors)
            ? '<div class="zu-stat-scale">' +
              (lt.tool_calls ? '<span>' + ttEsc(L("工具调用 ", "tools ") + countFmt(lt.tool_calls) + L(" 次", " calls")) + '</span>' : "") +
              (lt.retries ? '<span>' + ttEsc(L("重试 ", "retries ") + countFmt(lt.retries) + L(" 次", " times")) + '</span>' : "") +
              (lt.tool_errors ? '<span>' + ttEsc(L("错误 ", "errors ") + countFmt(lt.tool_errors) + L(" 次", " times")) + '</span>' : "") +
              '</div>' : "") +
          statModelsTable(lt.models) +
          '<div class="zu-stat-time">' +
            '<b>' + ttEsc(L("时间范围", "Time span")) + '</b>' +
            '<span>' + ((lt.started || lt.ended)
              ? (lt.started ? fmtStartS(lt.started) : "—") + " — " + (lt.ended ? fmtStartS(lt.ended) : "—")
              : "—") + '</span>' +
          '</div>' +
          '</div>');
      }
      if (state.show.win) {
        it(ico('<path d="M7.5 3h12a2 2 0 0 1 2 2v10M4.5 7h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-5.5 2V9a2 2 0 0 1 2-2z"/>') +
          '<span class="v">' + fmt(sess.total) + "</span>" +
          (state.theme === "pill" ? "" :
            (shrink ? "" : cachePct(sess.cache_read, sess.input)) +
            '<span class="dim">' + countFmt(sess.turns || 0) + L("轮 ", " turns · ") + countFmt(sess.requests || 0) + L("次", " req") + "</span>"),
          "\x01" +
          '<div class="zu-stat-tip zu-stat-tip--session">' +
          statHead(L("会话累计", "Session total"), L("全部请求", "All requests"),
            ((sess.title || "").trim() ? '<span class="zu-st-name">' + ttEsc(String(sess.title).replace(/\s+/g, " ").trim()) + '</span>' : "")) +
          '<div class="zu-stat-kpis">' +
            statKpi(L("总用量", "Total tokens"), ttEsc(fmt(sess.total || 0))) +
            statKpi(L("请求次数", "Requests"), ttEsc(countFmt(sess.requests || 0))) +
            ((state.cost && typeof sess.cost_usd === "number" && isFinite(sess.cost_usd))
              ? statKpi(L("预估费用", "Est. cost") + fxqIcon(sess.models, L("本会话", "this session")), ttEsc(fmtMoney(sess.cost_usd)))
              : "") +
          '</div>' +
          '<div class="zu-stat-grid2">' +
            statDetail(L("输入", "Input"), fmt(sess.input || 0),
              (hitPctOf(sess.input, sess.cache_read) >= 0 ? '<span class="hit">' + ttEsc(L("缓存命中率 ", "cache hit ") + hitPctOf(sess.input, sess.cache_read) + "%") + '</span>' : "")) +
            statDetail(L("输出", "Output"), fmt(sess.output || 0),
              (sess.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(sess.reasoning)) : "")) +
          '</div>' +
          ((sess.cache_write > 0)
            ? '<div class="zu-stat-grid2" style="margin-top:12px">' +
              statDetail(L("缓存写入", "Cache write"), fmt(sess.cache_write), "") + '<div></div></div>' : "") +
          '<div class="zu-stat-scale">' +
            '<span>' + ttEsc(countFmt(sess.turns || 0) + L(" 轮对话", " turns")) + '</span>' +
            (sess.tool_calls ? '<span>·</span><span>' + ttEsc(L("工具调用 ", "tools ") + countFmt(sess.tool_calls) + L(" 次", " calls")) + '</span>' : "") +
            (sess.retries ? '<span>·</span><span>' + ttEsc(L("重试 ", "retries ") + countFmt(sess.retries) + L(" 次", " times")) + '</span>' : "") +
          '</div>' +
          '<div class="zu-pj-mhead"><div class="zu-pj-mtitle">' + ttEsc(L("模型明细", "Models")) + '</div><div class="zu-pj-morder">' + ttEsc(L("按用量排序", "by usage")) + '</div></div>' +
          statTable(
            [L("模型", "Model"), L("Token 用量 ↓", "Tokens ↓"), L("请求次数", "Requests"), L("预估费用", "Est. cost")],
            (sess.models || []).slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); }).map(function (m1) {
              var name = m1.model || L("未知模型", "unknown");
              return '<tr>' +
                '<td class="zu-pj-mname" title="' + escAttr(name) + '">' + ttEsc(name) + '</td>' +
                '<td>' + ttEsc(fmt(m1.total || 0)) + '</td>' +
                '<td>' + ttEsc(countFmt(m1.requests || 0)) + '</td>' +
                '<td>' + (typeof m1.cost_usd === "number" && isFinite(m1.cost_usd) ? ttEsc(fmtMoney(m1.cost_usd)) : "—") + '</td>' +
                '</tr>';
            }).join("")) +
          (d.code && (d.code.add || d.code.del)
            ? '<div class="zu-stat-scale" style="margin-top:12px"><span>' + ttEsc(L("代码变更 ", "code ") + "+" + (d.code.add || 0) + " / -" + (d.code.del || 0) +
                (d.code.files ? L("（" + d.code.files + " 文件）", " (" + d.code.files + " files)") : "")) + '</span></div>' : "") +
          '<div class="zu-pj-time"><b>' + ttEsc(L("时间范围", "Time span")) + '</b><span>' +
            (sess.started ? fmtStartS(sess.started) : "—") + " — " + (sess.last_at ? fmtStartS(sess.last_at) : "—") + '</span></div>' +
          '</div>');      }
      if (state.show.today) {   // v213 移到会话累计之后（用户规格 2026-11-02，格序：速度→本轮→会话→今日→项目→工具→子代理→⚙）
        it(ico('<rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M7.5 2.5v4m9-4v4M3 10h18m-13.5 4h2m5 0h2m-9 4h2m5 0h2"/>') +
          '<span class="v">' + fmt(today.total) + "</span>",
          "\x01" +
          '<div class="zu-stat-tip zu-stat-tip--today">' +
          statHead(L("今日合计", "Today"), L("今天所有会话", "All sessions today")) +
          '<div class="zu-stat-kpis">' +
            statKpi(L("总用量", "Total tokens"), ttEsc(fmt(today.total || 0))) +
            statKpi(L("请求次数", "Requests"), ttEsc(countFmt(today.requests || 0))) +
            ((state.cost && typeof today.cost_usd === "number" && isFinite(today.cost_usd))
              ? statKpi(L("预估费用", "Est. cost") + fxqIcon(today.models, L("今日", "today")), ttEsc(fmtMoney(today.cost_usd)))
              : "") +
          '</div>' +
          '<div class="zu-stat-grid3">' +
            statDetail(L("输入用量", "Input"), fmt(today.input || 0),
              (today.input > 0 ? '<span class="hit">' + ttEsc(L("缓存命中率 ", "cache hit ") + Math.round((today.cache_read || 0) / today.input * 100) + "%") + '</span>' : "")) +
            statDetail(L("输出用量", "Output"), fmt(today.output || 0),
              (today.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(today.reasoning)) : "")) +
            statDetail(L("重试次数", "Retries"), countFmt(today.retries || 0), "") +
          '</div>' +
          statModelsTable(today.models) +
          '<div class="zu-pj-time"><b>' + ttEsc(L("时间范围", "Time span")) + '</b><span>' +
            (today.started ? fmtStartS(today.started) : "—") + " — " + (today.last_at ? fmtStartS(today.last_at) : "—") + '</span></div>' +
          '</div>');      }
      if (state.show.proj && sess.project) {   // v159 项目累计：本项目全部会话（含子代理），远端/不在本地库无此字段不渲染
        var pj = sess.project;
        var pjKey = (pickedSid || "") + ":" + (pj.started || 0);   // v214 项目卡归属键：项目变化（started 变）自动重置展开态
        if (pjKey !== projTipKey) { projTipKey = pjKey; projTipExpanded = false; }
        it(ico('<path d="M3.5 6.5a2 2 0 0 1 2-2h4.2l2 2h7.3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>') +
          '<span class="v">' + fmt(pj.total) + "</span>" +
          (state.theme === "pill" ? "" :
            (shrink ? "" : cachePct(pj.cache_read, pj.input)) +
            '<span class="dim">' + countFmt(pj.sessions || 0) + L("会话 ", " sessions · ") + countFmt(pj.requests || 0) + L("次", " req") + "</span>"),
"\x01" + buildProjectTipHTML(pj, pjKey), "zu-pj-item");
      }
      if (state.show.tools) {
        var toolRows = (tls.list || []).map(function (t1) {
          return '<div class="rt-tool"><span class="rt-tool-name">' + ttEsc(t1.name) + '</span><span class="rt-atom">' + ttEsc(countFmt(t1.count) + L(" 次", " calls")) + '</span><span class="rt-atom">' + (t1.duration_ms === 0 ? '0.0s' : sec(t1.duration_ms)) + (t1.errors ? ttEsc(L(" · 错误 ", " · errors ") + countFmt(t1.errors)) : "") + '</span></div>';
        }).join("");
        it(ico('<path d="M14.5 2.5a6 6 0 0 0-5.6 8.1L3.3 16.2a3.2 3.2 0 0 0 4.5 4.5l5.6-5.6a6 6 0 0 0 8.1-5.6l-4.1 3-3.8-3.8 3-4.1a6 6 0 0 0-2.1-2.1z"/>') +
          '<span class="v">' + countFmt(tls.total || 0) + "</span>" +
          (tls.errors ? '<span class="eb">' +
            ico('<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>') +
            tls.errors + "</span>" : ""),
          "\x01" +
          '<div class="zu-stat-tip zu-stat-tip--tools">' +
          statHead(L("工具调用", "Tool calls"), "") +
          '<div class="zu-stat-kpis cols2">' +
            statKpi(L("调用总数", "Total calls"), ttEsc(countFmt(tls.total || 0)) + ' <small>' + ttEsc(L("次", "calls")) + '</small>') +
            statKpi(L("错误", "Errors"), ttEsc(countFmt(tls.errors || 0)) + ' <small>' + ttEsc(L("次", "times")) + '</small>', (tls.errors ? "err" : "")) +
          '</div>' +
          (toolRows
            ? statTable([L("工具", "Tool"), L("调用次数", "Calls"), L("累计耗时", "Total time"), L("错误", "Errors")],
                (tls.list || []).map(function (t1) {
                  var errCell = t1.errors ? '<td class="err">' + ttEsc(countFmt(t1.errors)) + '</td>' : '<td class="dim0">0</td>';
                  var durTxt = !t1.duration_ms ? '0.0s' : (t1.duration_ms < 50 ? '&lt;0.1s' : ttEsc(sec(t1.duration_ms)));
                  var durCls = (!t1.duration_ms || t1.duration_ms < 50) ? ' class="dim0"' : '';
                  return '<tr><td class="zu-pj-mname" title="' + escAttr(t1.name) + '">' + ttEsc(t1.name) + '</td>' +
                    '<td>' + ttEsc(countFmt(t1.count || 0)) + '</td>' +
                    '<td' + durCls + '>' + durTxt + '</td>' + errCell + '</tr>';
                }).join(""))
            : '<div class="zu-stat-note">' + ttEsc(L("无工具调用记录", "No tool calls recorded")) + '</div>') +
          '</div>');      }
      if (state.show.sub) {
        /* v93：随「上下文容量」格移除改为始终展示（零值也显示，口径与其他格统一）。
         * v217：悬停/点击都开统一浮层（.zu-sub-pop），__tip 置空不再走通用 tooltip
         * ——旧五段卡与「查看子代理明细」CTA 移除，明细能力由统一浮层右侧承接。 */
        var sb = d.sub || { requests: 0, total: 0, input: 0, output: 0, cache_read: 0, active: false };
        it(ico('<circle cx="5" cy="5" r="3"/><circle cx="19" cy="8" r="3"/><circle cx="5" cy="19" r="3"/><path d="M5 8v8m0-4h9a5 5 0 0 0 5-1"/>') +
          '<span class="v">' + fmt(sb.total) + "</span>" +
(sb.active ? '<span class="ok dot">●</span>' : ""),
          null, "zu-sub");
      }

      return { s: items.join('<span class="sep"></span>') || '<span class="dim">' + L("全部显示项已关闭", "All display items are off") + '</span>', tips: tips };
    }

    /* 当前会话识别（v34 起 mine 优先，此处为兜底启发式）：ZCode 在 localStorage 的
     * "zcode-v4-last-session:v1:<工作区路径>" 键里保存每个工作区当前打开的会话 id。
     * 键随会话切换由应用更新（新开空会话时应用还会删键）；但 localStorage 全窗口共享、
     * 键对"自动新建的会话"更新滞后，多窗口下根本分不清哪个键属于本窗口 ——
     * 所以 v34 起正常路径是泵按窗口注入的 mine（渲染端经 IPC 上报的焦点会话），
     * 只有泵无该窗口信息时（辅助窗口/旧泵）才落到这里：取所有键值与 payload.recent
     * 的 sid 求交集；多候选取最近活跃（数值 last_at 比较，勿用 HH:MM:SS 字符串，跨午夜会排错）。
     * v32：键值即使不在 recent 池里也作为 want 返回（挂 window.__zusageWantSid），
     * 泵把它传给 zusage.py 强制纳入快照——刚开的新会话/超出 6+6 池的会话也能显示自己的数据。
     * 注意：会话标题不在可扫描的 DOM 文本节点里（顶栏标题扫描方案实测永远失败，勿回退）。 */
    var pickedSid = "", wsPrev = null, lastHtml = "";
    function watchQuotaSelection(pane) {
      if (pane === quotaPaneRoot) return;
      if (quotaSelectionObserver) quotaSelectionObserver.disconnect();
      quotaSelectionObserver = null;
      quotaPaneRoot = pane;
      if (!pane) return;
      quotaSelectionObserver = new MutationObserver(function () {
        if (inactive()) return;
        if (readQuotaSelection() && state.data) render(state.data);
      });
      quotaSelectionObserver.observe(pane, { subtree: true, childList: true, attributes: true,
        attributeFilter: ["data-provider", "data-model", "data-session-id"] });
    }
    function readQuotaSelection() {
      var el = wantedEl || composer, pane = null, selection = null;
      var sid = instSid || pickedSid || "";
      if (el && el.isConnected) {
        for (var parent = el; parent && parent !== document.body; parent = parent.parentElement) {
          var tid = parent.getAttribute && parent.getAttribute("data-testid");
          if (tid && tid.indexOf("v4-session-pane-") === 0) { pane = parent; break; }
        }
      }
      watchQuotaSelection(pane);
      if (pane) {
        selection = { sid: sid, providerId: "", modelId: "" };
        var paneSid = pane.getAttribute("data-session-id");
        var paneId = pane.getAttribute("data-testid").slice("v4-session-pane-".length);
        if (paneSid === sid && (pid === "auto" || paneId === pid)) {
          var nodes = pane.querySelectorAll('[data-testid="v4-model-config"]');
          var own = [];
          for (var i = 0; i < nodes.length; i++) {
            var owner = nodes[i].parentElement;
            while (owner && owner !== pane) {
              var ot = owner.getAttribute && owner.getAttribute("data-testid");
              if (ot && ot.indexOf("v4-session-pane-") === 0) break;
              owner = owner.parentElement;
            }
            if (owner === pane) own.push(nodes[i]);
          }
          if (own.length) quotaMarkerSeen = true;
          if (!own.length && !quotaMarkerSeen) selection = null;
          if (own.length === 1) {
            var provider = own[0].getAttribute("data-provider");
            var model = own[0].getAttribute("data-model");
            if (typeof provider === "string" && provider.length <= 160 &&
                typeof model === "string" && model.length <= 160 && !/[\x00-\x1f\x7f]/.test(provider + model)) {
              selection.providerId = provider.trim();
              selection.modelId = model.trim();
            }
          }
        }
      } else if (quotaSelection) {
        selection = { sid: sid, providerId: "", modelId: "" };
      }
      if (JSON.stringify(selection) === JSON.stringify(quotaSelection)) return false;
      quotaSelection = selection;
      if (instances.length) reportQuotaSelections();
      return true;
    }
    function effectiveQuotaProvider() {
      return quotaSelection ? quotaSelection.providerId : (quotaProvider || quotaFallback);
    }
    function pickCurrent(d) {
      var recent = d.recent || [];
      if (!recent.length) return null;
      var bySid = {}, kv = {};
      for (var i = 0; i < recent.length; i++) bySid[recent[i].sid] = recent[i];
      try {
        Object.keys(localStorage).forEach(function (k) {
          if (/^zcode-v4-last-session:/.test(k)) {
            var v = localStorage.getItem(k);
            if (v && /^[A-Za-z0-9_-]+$/.test(v)) kv[k] = v;
          }
        });
      } catch (e) { return null; }
      if (!Object.keys(kv).length) return null;
      var hit = {}, firstKeyVal = "";
      for (var k in kv) {
        if (bySid[kv[k]]) hit[k] = kv[k];
        if (!firstKeyVal) firstKeyVal = kv[k];
      }
      var switched = null;
      if (wsPrev) {
        for (var k2 in kv) {
          if (wsPrev[k2] && wsPrev[k2] !== kv[k2]) switched = kv[k2];   // 该工作区刚切换了会话
        }
      }
      wsPrev = kv;
      /* want = 当前真正打开的会话（切换优先，否则任一键值），交由泵强制补拉 */
      var want = switched || firstKeyVal;
      if (switched && bySid[switched]) return { sess: bySid[switched], want: want };
      var cands = [];
      for (var k3 in hit) cands.push(bySid[hit[k3]]);
      if (cands.length === 1) return { sess: cands[0], want: want };
      if (!cands.length) return { sess: null, want: want };
      var best = cands[0];   // 多候选：取最近活跃的
      for (var n = 1; n < cands.length; n++) {
        if ((cands[n].last_at || 0) > (best.last_at || 0)) best = cands[n];
      }
      return { sess: best, want: want };
    }

    /* 子代理查看视图识别：子代理会话的任务提示词会作为聊天气泡文本出现在消息流里，
     * 用 recent 中 is_sub 候选的标题前缀（前 30 字）在 DOM 文本里匹配。
     * （主会话的标题不在 DOM 文本里，但子代理视图的气泡是普通文本，可匹配。） */
    /* 零值会话 stub：当前会话在共享池里还没有数据行（新会话没发过消息/还没拉到）时，
     * 显示"当前会话的 0 值"。绝不回退到池里别的会话 —— 显示错会话的数字正是 v34 修的 bug。 */
    function stubFor(sid) {
      return { sid: String(sid || ""), title: "", active: false, turns: 0, requests: 0,
        input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0,
        tool_calls: 0, retries: 0, ctx: 0, updated: "", last_at: 0, ctx_exc: 0, started: 0,
        last_turn: {requests: 0, retries: 0, tool_calls: 0, tool_errors: 0, input: 0, output: 0,
          reasoning: 0, cache_read: 0, cache_write: 0, total: 0, duration_ms: 0, ttft_ms: 0, started: 0, ended: 0},
        last: {duration_ms: 0, ttft_ms: 0, model: "", tps: 0, startedAt: 0, endedAt: 0},
        code: {add: null, del: null, files: null},
        tools: {total: 0, errors: 0, list: []},
        sub: {requests: 0, total: 0, input: 0, output: 0, cache_read: 0, reasoning: 0,
          cache_write: 0, active: false, list: []},
        context_window: 0, context_auto: false };
    }

    /* ---------- renderer store 桥客户端（v71，实例级）：一个 pane 一个订阅 ----------
     * 低频（2s）能力检测：API 在 + diagnostics 里有本 pane 会话的 topic → 绑定 store；
     * 绑定后 tracker.ingest 由订阅推送驱动（实时），store 关闭/换代（getState null /
     * 快照 sessionId 变）→ off 释放，下轮 tick 重绑。全链路失败 = 降级 DB 路径。 */
    function bridgeDetach(handle) {
      if (!handle || handle.dead) return;
      handle.dead = true;
      try { if (handle.off) handle.off(); } catch (e) { }   // 停订阅 + dispose tracker
      try { handle.store.off(); } catch (e) { }
      if (bridge.handle === handle) { bridge.handle = null; bridge.turnId = ""; }
      subRateDetach();   // 主桥释放（换代/切换/世代失效）时子代理速率桥一并释放
    }

    /* ---------- 子代理运行期速率桥（v97）：主会话 rows 的 subagent 行自带
     * childSessionId（turn-stats 的 runningSubagents 集合），据此用同一套 zuTryBindStore
     * 为**每个**运行中的子代理绑定会话 store，字符增量 ÷ c2t 估算各自输出 tok/s；
     * 主 chip 显示合计（Σ 有效槽位，并行 ≥2 个时动词后缀 ×N），tooltip/明细面板按
     * 槽位逐个展示。运行中请求未入库（DB 完成才写行，150s 实测零 running 行），这是
     * 唯一的实时来源；子代理思考文本若不进 rows（与主会话同款限制），characterRate
     * 为 null，该槽位速率缺席。生命周期跟随主桥：主桥释放/换代即全解绑；行结束
     * （runningSubagents 收敛）下一次 updateLive 自然解绑。
     * 上限保护：宿主 schema 允许 64 个并行 subagent，全绑会让订阅失控——只绑
     * rowId 最大（最新派发）的前 8 个，其余不估算（turn-stats 已按 rowId 升序给出）。 */
    var MAX_SUB_SLOTS = 8;
    var subRate = { slots: {}, sum: { rate: null, at: 0, count: 0 } };
    /* 释放槽位的绑定资源但保留槽位（want/retryAt）：绑定失败/首调 detach 时等待
     * 2s 后重试；对未绑定槽位（handle 为 null）调用也安全。 */
    /* ---------- 子代理行内速率 chip（v176）：把逐槽位估算/快照真实值投到会话流 Agent 行 ----------
     * 宿主 v4 行 testid = TID_V4_SUBAGENT_OPEN_SIDE_PANE + childSessionId（宿主 e2e 锁定的
     * 稳定契约），与上面 subRate 槽位键天然同源，两态互补：
     * ① 运行中槽位 3s 内有估算速率 →「估 X t/s」；思考期无字符流不显示（行内流光动画
     *    已指示运行中）；
     * ② 槽位收敛后读泵快照 sub.list 的 tps_avg（已完成段加权平均真实速率，查询无时间窗，
     *    重启后历史行也能回填）→「X t/s」；槽位解绑与泵推送之间有几秒无 chip 间隙，属预期。
     * chip 插在 .tool-summary-content 之后（缺该节点退回行末尾）；React 对未知末尾节点
     * 通常不回收，行虚拟化卸载/整行重挂时 chip 随节点消亡——本函数无状态对账，每拍按期望
     * 形态幂等重建，不持有 chip 引用。扫描根 = composer/wantedEl 祖先链最近
     * [data-session-id]（本 pane 会话壳）：分屏同会话时两实例各管各 pane，绝不互相覆写。
     * 悬停 tooltip 内容构建器挂 chip.__zuT，显隐由模块级 subTip 的委托监听驱动。 */
    var SUBROW_TID_PREFIX = "v4-subagent-open-side-pane-";
    function subRowPaneRoot() {
      var el = (composer && composer.isConnected) ? composer : (wantedEl && wantedEl.isConnected ? wantedEl : null);
      try {
        while (el && !(el.hasAttribute && el.hasAttribute("data-session-id"))) el = el.parentElement;
      } catch (e) { return null; }
      return el && el.isConnected ? el : null;
    }
    function subRowDurText(ms) {
      if (!(ms >= 1000)) return sec(ms);
      var total = Math.floor(ms / 1000), m = Math.floor(total / 60), s = total % 60;
      return m ? L(m + "分" + (s ? s + "秒" : ""), m + "m" + (s ? " " + s + "s" : "")) : L(total + "秒", total + "s");
    }
    /* tooltip 构建器收「数据包」而非元素：模块 showSubTip 的调用约定是
     * el.__zuT.buildTip(el.__zuT)（同 tpsChipTipHTML(t)），包里携带取数所需
     * 全部字段——v178 首版误按元素取 __zu* 导致全部 undefined、tooltip 恒显
     * 「— t/s」+无名（实机截图定案）。 */
    function subRowTipHTML(t) {
      var csid = t.csid || "", mode = t.mode || "";
      var s1 = null, list = (lastSub && lastSub.list) || [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].sid === csid) { s1 = list[i]; break; }
      var name = (s1 && (String(s1.task || "").trim() || String(s1.title || "").trim())) ||
        String(t.title || "").trim() || L("子代理", "Sub-agent");
      var agent = s1 && s1.agent ? String(s1.agent) : "";
      /* 作用域样式挂在内容串里（同 quotaTip/tpsTip）：浮层是 body 级共享元素，样式随内容走 */
      var out = "<style>" +
        '.zusage-subrate-tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px;overflow-wrap:anywhere}' +
        '.zusage-subrate-tip .rt-row{display:flex;gap:12px;margin:4px 0;align-items:flex-start}' +
        '.zusage-subrate-tip .rt-row b{flex:0 0 86px;min-width:0;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500}' +
        '.zusage-subrate-tip .rt-row span{min-width:0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}' +
        ".zusage-subrate-tip .sub-agent{font-weight:400;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:.9em}" +
        "</style>";
      out += '<div class="rt-h">' + ttEsc(name) + (agent ? ' <span class="sub-agent">' + ttEsc(agent) + "</span>" : "") + "</div>";
      var rateTxt = (t.rate || "—") + L(" t/s", " t/s");
      if (mode === "est") {
        out += ttRow(L("估速", "Estimate"), rateTxt);
        var sl = subRate.slots[csid];
        if (sl && sl.store) {
          try {
            var st = sl.store.getState(), snap = st && st.snapshot;
            var tid = zuActiveTurnId(snap), ts = (tid && sl.tracker) ? sl.tracker.get(tid) : null;
            if (ts && ts.startedAt) out += ttRow(L("已运行", "Running for"), subRowDurText(Date.now() - ts.startedAt));
            if (ts && ts.totalCharacters > 0) {
              var c2t = sl.calib || (bridge.handle && bridge.handle.charsPerToken) || DEFAULT_CHARS_PER_TOKEN;
              out += ttRow(L("累计输出", "Output"), "≈" + fmt(ts.totalCharacters / c2t) + L(" token", " tokens"));
            }
          } catch (e) { }
        }
        out += ttRow(L("口径", "Basis"), L("字符增量估算；完成后切换真实值", "Text-delta estimate; actual value on completion"));
      } else {
        out += ttRow(L("平均速率", "Average rate"), rateTxt);
        if (s1) {
          if (s1.input != null) out += ttRow(L("输入", "Input"), fmt(s1.input) + L(" token", " tokens"));
          out += ttRow(L("输出", "Output"), fmt(s1.output) + L(" token（含思考）", " tokens (thinking incl.)"));
          out += ttRow(L("请求数", "Requests"), (s1.requests || 0) + L(" 次", " requests"));
          if (s1.started || s1.last) out += ttRow(L("起始时间", "Time span"),
            (s1.started ? fmtStartS(s1.started) : "—") + " - " + (s1.last ? fmtStartS(s1.last) : "—"));
        }
        out += ttRow(L("口径", "Basis"), L("已完成段加权平均（Σ输出 ÷ Σ生成耗时）", "Completed-segment weighted average"));
      }
      return out;
    }
    function renderSubAgentRows() {
      if (inactive()) return;
      if (!(composer && composer.isConnected) && !(wantedEl && wantedEl.isConnected)) return;
      var rootEl = subRowPaneRoot();
      if (!rootEl) return;
      /* v178 ⚙「子代理行内速率」门：关闭即摘净本 pane 已有 chip 并收起本 pane 的悬停
       * 浮层，重开由 0.1s 心跳自然重建；只门控行内展示——槽位估算与主 chip「子代理
       * 运行中 · 估 X t/s」合计是独立功能，照常工作。 */
      if (!state.show.subRate) {
        var staleChips = rootEl.querySelectorAll(".zu-subrate");
        for (var sc = 0; sc < staleChips.length; sc++) { try { staleChips[sc].remove(); } catch (e) { } }
        if (subTipFor && (rootEl.contains(subTipFor) || !subTipFor.isConnected)) hideSubTip();
        return;
      }
      var now = Date.now(), list = (lastSub && lastSub.list) || [], bySid = {};
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].sid) bySid[list[i].sid] = list[i];
      var rows;
      try { rows = rootEl.querySelectorAll('[data-testid^="' + SUBROW_TID_PREFIX + '"]'); } catch (e) { return; }
      var dark = true;
      try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
      for (var r = 0; r < rows.length; r++) {
        var el = rows[r], tattr = String(el.getAttribute("data-testid") || "");
        if (tattr.length <= SUBROW_TID_PREFIX.length) continue;
        var csid = tattr.slice(SUBROW_TID_PREFIX.length);
        var sl = subRate.slots[csid];
        var rate = (sl && sl.rate != null && now - sl.at <= 3000) ? sl.rate : null;
        var mode = rate != null ? "est" : "";
        if (!mode && bySid[csid] && bySid[csid].tps_avg > 0) { rate = bySid[csid].tps_avg; mode = "real"; }
        var chip = el.querySelector(".zu-subrate");
        if (!mode) { if (chip) { try { chip.remove(); } catch (e) { } } continue; }
        var band = tpsBand(rate);
        var bandCls = band ? band.cls : "ok";
        /* 十档色的浅色加深版是后代选择器（.zu-light .ok），档位类挂内层 span、
         * zu-light 挂 chip 本体（同 syncTpsChip 结构），两态切换只换内层。 */
        var cls = "zu-subrate" + (dark ? "" : " zu-light");
        var txt = (mode === "est" ? L("估 ", "est ") : "") + rate.toFixed(1) + L(" t/s", " t/s");
        var sig = mode + "|" + bandCls + "|" + cls + "|" + txt;
        if (!chip) {
          chip = document.createElement("span");
          chip.className = cls;
          chip.innerHTML = '<span class="' + bandCls + '">' + ttEsc(txt) + "</span>";
          chip.__zuSig = sig;
          var anchor = el.querySelector(".tool-summary-content") || el;
          try {
            if (anchor === el) el.appendChild(chip);
            else anchor.parentNode.insertBefore(chip, anchor.nextSibling);
          } catch (e) { continue; }
        } else if (chip.parentElement !== el) {
          try { el.appendChild(chip); } catch (e) { }
        }
        if (chip.__zuSig !== sig) {
          chip.__zuSig = sig;
          chip.className = cls;
          chip.innerHTML = '<span class="' + bandCls + '">' + ttEsc(txt) + "</span>";
        }
        chip.setAttribute("data-zusage-csid", csid);
        /* tooltip 数据包（buildTip 收包不收元素，见 subRowTipHTML 注释）：
         * showSubTip 以 el.__zuT.buildTip(el.__zuT) 调用，取数全走包内字段。 */
        chip.__zuT = { buildTip: subRowTipHTML, csid: csid, mode: mode,
                       rate: rate.toFixed(1), title: el.getAttribute("title") || "" };
      }
      if (subTipFor && subTipFor.isConnected && subTipFor.__zuT) showSubTip(subTipFor);   // 悬停中随推送刷新（签名幂等不重建）
      else if (subTipFor && !subTipFor.isConnected) hideSubTip();
    }
    function subSlotReset(sl) {
      if (sl.handle) sl.handle.dead = true;
      try { if (sl.off) sl.off(); } catch (e) { }
      try { if (sl.store) sl.store.off(); } catch (e) { }
      if (sl.tracker) { try { sl.tracker.dispose(); } catch (e) { } }
      sl.handle = null; sl.store = null; sl.tracker = null; sl.off = null;
      sl.rate = null; sl.calib = null; sl.st = "";   // v180：清 st，防诊断把重试窗口计成 bound/rate
      sl.retryAt = Date.now() + 2000;
    }
    function subSlotDetach(sid) {   // 彻底移除槽位（行结束/主桥释放）
      var sl = subRate.slots[sid];
      if (!sl) return;
      subSlotReset(sl);
      delete subRate.slots[sid];
    }
    function subRateDetach() {   // 全解绑（主桥释放/换代/世代失效）
      for (var sid in subRate.slots) subSlotDetach(sid);
      subRate.sum = { rate: null, at: 0, count: 0 };
    }
    /* 合计视图：Σ 3 秒内有效的槽位速率；全部无效/过期时为 {rate:null}（chip 回退状态词）。 */
    function subRateRecompute() {
      var now = Date.now(), sum = 0, at = 0, count = 0;
      for (var sid in subRate.slots) {
        var sl = subRate.slots[sid];
        if (sl.rate != null && now - sl.at <= 3000) { sum += sl.rate; count++; if (sl.at > at) at = sl.at; }
      }
      subRate.sum = count ? { rate: sum, at: at, count: count } : { rate: null, at: 0, count: 0 };
    }
    /* 单槽位展示文案（tooltip/明细面板共用）：有效速率 →「估 X t/s」；已绑但无速率
     * （思考期）→「估算中…」；未绑槽位 → 空串。 */
    function subRateSlotText(sid) {
      var sl = subRate.slots[sid];
      if (!sl) return "";
      var now = Date.now();
      return sl.rate != null && now - sl.at <= 3000
        ? L("估 ", "est ") + sl.rate.toFixed(1) + L(" t/s", " t/s")
        : L("估算中…", "estimating…");
    }
    /* ---------- 子代理行内速率 chip（v176）：把逐槽位估算/快照真实值投到会话流 Agent 行 ----------
     * 宿主 v4 行 testid = TID_V4_SUBAGENT_OPEN_SIDE_PANE + childSessionId（宿主 e2e 锁定的
     * 稳定契约），与上面 subRate 槽位键天然同源，两态互补：
     * ① 运行中槽位 3s 内有估算速率 →「估 X t/s」；思考期无字符流不显示（行内流光动画
     *    已指示运行中）；
     * ② 槽位收敛后读泵快照 sub.list 的 tps_avg（已完成段加权平均真实速率，查询无时间窗，
     *    重启后历史行也能回填）→「X t/s」；槽位解绑与泵推送之间有几秒无 chip 间隙，属预期。
     * chip 插在 .tool-summary-content 之后（缺该节点退回行末尾）；React 对未知末尾节点
     * 通常不回收，行虚拟化卸载/整行重挂时 chip 随节点消亡——本函数无状态对账，每拍按期望
     * 形态幂等重建，不持有 chip 引用。扫描根 = composer/wantedEl 祖先链最近
     * [data-session-id]（本 pane 会话壳）：分屏同会话时两实例各管各 pane，绝不互相覆写。
     * 悬停 tooltip 内容构建器挂 chip.__zuT，显隐由模块级 subTip 的委托监听驱动。 */
    var SUBROW_TID_PREFIX = "v4-subagent-open-side-pane-";
    function subRowPaneRoot() {
      var el = (composer && composer.isConnected) ? composer : (wantedEl && wantedEl.isConnected ? wantedEl : null);
      try {
        while (el && !(el.hasAttribute && el.hasAttribute("data-session-id"))) el = el.parentElement;
      } catch (e) { return null; }
      return el && el.isConnected ? el : null;
    }
    function subRowDurText(ms) {
      if (!(ms >= 1000)) return sec(ms);
      var total = Math.floor(ms / 1000), m = Math.floor(total / 60), s = total % 60;
      return m ? L(m + "分" + (s ? s + "秒" : ""), m + "m" + (s ? " " + s + "s" : "")) : L(total + "秒", total + "s");
    }
    /* tooltip 构建器收「数据包」而非元素：模块 showSubTip 的调用约定是
     * el.__zuT.buildTip(el.__zuT)（同 tpsChipTipHTML(t)），包里携带取数所需
     * 全部字段——v178 首版误按元素取 __zu* 导致全部 undefined、tooltip 恒显
     * 「— t/s」+无名（实机截图定案）。 */
    function subRowTipHTML(t) {
      var csid = t.csid || "", mode = t.mode || "";
      var s1 = null, list = (lastSub && lastSub.list) || [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].sid === csid) { s1 = list[i]; break; }
      var name = (s1 && (String(s1.task || "").trim() || String(s1.title || "").trim())) ||
        String(t.title || "").trim() || L("子代理", "Sub-agent");
      var agent = s1 && s1.agent ? String(s1.agent) : "";
      /* 作用域样式挂在内容串里（同 quotaTip/tpsTip）：浮层是 body 级共享元素，样式随内容走 */
      var out = "<style>" +
        '.zusage-subrate-tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px;overflow-wrap:anywhere}' +
        '.zusage-subrate-tip .rt-row{display:flex;gap:12px;margin:4px 0;align-items:flex-start}' +
        '.zusage-subrate-tip .rt-row b{flex:0 0 86px;min-width:0;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500}' +
        '.zusage-subrate-tip .rt-row span{min-width:0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}' +
        ".zusage-subrate-tip .sub-agent{font-weight:400;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:.9em}" +
        "</style>";
      out += '<div class="rt-h">' + ttEsc(name) + (agent ? ' <span class="sub-agent">' + ttEsc(agent) + "</span>" : "") + "</div>";
      var rateTxt = (t.rate || "—") + L(" t/s", " t/s");
      if (mode === "est") {
        out += ttRow(L("估速", "Estimate"), rateTxt);
        var sl = subRate.slots[csid];
        if (sl && sl.store) {
          try {
            var st = sl.store.getState(), snap = st && st.snapshot;
            var tid = zuActiveTurnId(snap), ts = (tid && sl.tracker) ? sl.tracker.get(tid) : null;
            if (ts && ts.startedAt) out += ttRow(L("已运行", "Running for"), subRowDurText(Date.now() - ts.startedAt));
            if (ts && ts.totalCharacters > 0) {
              var c2t = sl.calib || (bridge.handle && bridge.handle.charsPerToken) || DEFAULT_CHARS_PER_TOKEN;
              out += ttRow(L("累计输出", "Output"), "≈" + fmt(ts.totalCharacters / c2t) + L(" token", " tokens"));
            }
          } catch (e) { }
        }
        out += ttRow(L("口径", "Basis"), L("字符增量估算；完成后切换真实值", "Text-delta estimate; actual value on completion"));
      } else {
        out += ttRow(L("平均速率", "Average rate"), rateTxt);
        if (s1) {
          if (s1.input != null) out += ttRow(L("输入", "Input"), fmt(s1.input) + L(" token", " tokens"));
          out += ttRow(L("输出", "Output"), fmt(s1.output) + L(" token（含思考）", " tokens (thinking incl.)"));
          out += ttRow(L("请求数", "Requests"), (s1.requests || 0) + L(" 次", " requests"));
          if (s1.started || s1.last) out += ttRow(L("起始时间", "Time span"),
            (s1.started ? fmtStartS(s1.started) : "—") + " - " + (s1.last ? fmtStartS(s1.last) : "—"));
        }
        out += ttRow(L("口径", "Basis"), L("已完成段加权平均（Σ输出 ÷ Σ生成耗时）", "Completed-segment weighted average"));
      }
      return out;
    }
    function renderSubAgentRows() {
      if (inactive()) return;
      if (!(composer && composer.isConnected) && !(wantedEl && wantedEl.isConnected)) return;
      var rootEl = subRowPaneRoot();
      if (!rootEl) return;
      /* v178 ⚙「子代理行内速率」门：关闭即摘净本 pane 已有 chip 并收起本 pane 的悬停
       * 浮层，重开由 0.1s 心跳自然重建；只门控行内展示——槽位估算与主 chip「子代理
       * 运行中 · 估 X t/s」合计是独立功能，照常工作。 */
      if (!state.show.subRate) {
        var staleChips = rootEl.querySelectorAll(".zu-subrate");
        for (var sc = 0; sc < staleChips.length; sc++) { try { staleChips[sc].remove(); } catch (e) { } }
        if (subTipFor && (rootEl.contains(subTipFor) || !subTipFor.isConnected)) hideSubTip();
        return;
      }
      var now = Date.now(), list = (lastSub && lastSub.list) || [], bySid = {};
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].sid) bySid[list[i].sid] = list[i];
      var rows;
      try { rows = rootEl.querySelectorAll('[data-testid^="' + SUBROW_TID_PREFIX + '"]'); } catch (e) { return; }
      var dark = true;
      try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
      for (var r = 0; r < rows.length; r++) {
        var el = rows[r], tattr = String(el.getAttribute("data-testid") || "");
        if (tattr.length <= SUBROW_TID_PREFIX.length) continue;
        var csid = tattr.slice(SUBROW_TID_PREFIX.length);
        var sl = subRate.slots[csid];
        var rate = (sl && sl.rate != null && now - sl.at <= 3000) ? sl.rate : null;
        var mode = rate != null ? "est" : "";
        if (!mode && bySid[csid] && bySid[csid].tps_avg > 0) { rate = bySid[csid].tps_avg; mode = "real"; }
        var chip = el.querySelector(".zu-subrate");
        if (!mode) { if (chip) { try { chip.remove(); } catch (e) { } } continue; }
        var band = tpsBand(rate);
        var bandCls = band ? band.cls : "ok";
        /* 十档色的浅色加深版是后代选择器（.zu-light .ok），档位类挂内层 span、
         * zu-light 挂 chip 本体（同 syncTpsChip 结构），两态切换只换内层。 */
        var cls = "zu-subrate" + (dark ? "" : " zu-light");
        var txt = (mode === "est" ? L("估 ", "est ") : "") + rate.toFixed(1) + L(" t/s", " t/s");
        var sig = mode + "|" + bandCls + "|" + cls + "|" + txt;
        if (!chip) {
          chip = document.createElement("span");
          chip.className = cls;
          chip.innerHTML = '<span class="' + bandCls + '">' + ttEsc(txt) + "</span>";
          chip.__zuSig = sig;
          var anchor = el.querySelector(".tool-summary-content") || el;
          try {
            if (anchor === el) el.appendChild(chip);
            else anchor.parentNode.insertBefore(chip, anchor.nextSibling);
          } catch (e) { continue; }
        } else if (chip.parentElement !== el) {
          try { el.appendChild(chip); } catch (e) { }
        }
        if (chip.__zuSig !== sig) {
          chip.__zuSig = sig;
          chip.className = cls;
          chip.innerHTML = '<span class="' + bandCls + '">' + ttEsc(txt) + "</span>";
        }
        chip.setAttribute("data-zusage-csid", csid);
        /* tooltip 数据包（buildTip 收包不收元素，见 subRowTipHTML 注释）：
         * showSubTip 以 el.__zuT.buildTip(el.__zuT) 调用，取数全走包内字段。 */
        chip.__zuT = { buildTip: subRowTipHTML, csid: csid, mode: mode,
                       rate: rate.toFixed(1), title: el.getAttribute("title") || "" };
      }
      if (subTipFor && subTipFor.isConnected && subTipFor.__zuT) showSubTip(subTipFor);   // 悬停中随推送刷新（签名幂等不重建）
      else if (subTipFor && !subTipFor.isConnected) hideSubTip();
    }
    /* 每次主桥数据到达时 reconcile：不在 runningSubagents 里的槽位解绑，新出现的
     * 尝试绑定（槽位级 2s 节流——updateLive 挂在 0.1s 心跳上，不节流会让 diag 全表
     * 枚举跟着心跳空转）。 */
    function subRateTick(runningSubagents) {
      var list = [];
      if (runningSubagents) {
        /* turn-stats 按 rowId 升序给出（最早在前）；超上限时从尾部取，保住的是
         * 最新派发的 8 个（v180 review 修正：旧实现取头部=最早派发，与注释相反） */
        for (var i = runningSubagents.length - 1; i >= 0 && list.length < MAX_SUB_SLOTS; i--) {
          var cs = runningSubagents[i] && runningSubagents[i].childSessionId;
          if (cs && list.indexOf(cs) < 0) list.push(cs);
        }
      }
      for (var sid in subRate.slots) if (list.indexOf(sid) < 0) subSlotDetach(sid);
      for (var j = 0; j < list.length; j++) {
        if (!subRate.slots[list[j]]) {
          subRate.slots[list[j]] = { handle: null, store: null, tracker: null, off: null,
                                     rate: null, at: 0, calib: null, retryAt: 0, want: list[j], st: "" };
        }
        subTryBindSlot(subRate.slots[list[j]]);
      }
      subRateRecompute();
      /* v179 定位诊断：原地写字段（对象不换引用），随 ~15 次泵拉取落 diag-*.json。
       * 绑定与否按 handle 判（v180 review：reset 重试窗口的槽位残留旧 st 会把
       * 已解绑槽位计成 bound/rate），未绑定槽位一律入 noStore 桶。 */
      var dBound = 0, dRate = 0, dThink = 0, dCalib = 0, dNo = 0;
      for (var dKey in subRate.slots) {
        var dSl = subRate.slots[dKey];
        if (!dSl.handle) { dNo++; continue; }
        dBound++;
        if (dSl.st === "rate") dRate++;
        else if (dSl.st === "thinking") dThink++;
        else if (dSl.st === "calib") dCalib++;
      }
      SUBRATE_DIAG.want = list.length;
      SUBRATE_DIAG.bound = dBound;
      SUBRATE_DIAG.rate = dRate;
      SUBRATE_DIAG.think = dThink;
      SUBRATE_DIAG.calib = dCalib;
      SUBRATE_DIAG.noStore = dNo;
      SUBRATE_DIAG.acqFn = typeof window.__zusageAcquireConversationStore === "function" ? 1 : 0;
      SUBRATE_DIAG.t = Date.now();
    }
    function subTryBindSlot(sl) {
      if (sl.handle || Date.now() < sl.retryAt) return;
      var store = zuTryBindStore(sl.want);
      if (store) {
        sl.st = "bound";
      } else {
        /* v179：后台运行子代理在宿主注册表里没有现成 store（目录面板不下钻不订阅，
         * T2 上线以来运行期估算从未真正工作过的根因）。桥 v2 提供
         * __zusageAcquireConversationStore：按本 pane 已验证 scope 的父工作区
         * acquire 子会话租约（同下钻路径，refcount 计数、off 时 release）。
         * 仅 sess_subagent_ 前缀 + 本地会话；桥未升级（v1）时为 null，退回 2s 重试。 */
        var scope = readPaneScope(wantedEl, pickedSid || instSid, pid);
        if (scope && !scope.remoteSessionId) store = zuAcquireSubStore(sl.want, scope);
        if (!store) {
          sl.st = "noStore";
          sl.retryAt = Date.now() + 2000;
          return;   // 注册表里还没有该 topic 且不可 acquire：2s 后再试
        }
        sl.st = "acquired";
      }
      var h = { dead: false, sid: sl.want };
      var tracker = TURN_STATS.createTracker();
      sl.handle = h; sl.store = store; sl.tracker = tracker;
      var offFn = TURN_STATS.subscribeStore(store, tracker, function () {
        if (inactive() || h.dead) { subSlotReset(sl); subRateRecompute(); return; }
        var st = null;
        try { st = store.getState(); } catch (e) { st = null; }
        var snap = st && st.snapshot;
        if (!snap || snap.sessionId !== sl.want) { subSlotReset(sl); subRateRecompute(); return; }   // 关闭/换代：重置待重试
        var tid = zuActiveTurnId(snap);
        var stats = tid ? tracker.get(tid) : null;
        if (stats && !stats.complete) {
          if (stats.characterRate != null) {
            sl.rate = stats.characterRate /
              (sl.calib || (bridge.handle && bridge.handle.charsPerToken) || DEFAULT_CHARS_PER_TOKEN);
            sl.at = Date.now();
            sl.st = "rate";
          } else {
            sl.rate = null;   // 思考期无可测字符流：该槽位缺席合计
            sl.st = "thinking";
          }
        } else if (stats && stats.complete && stats.outputTokens > 0 && stats.totalCharacters > 0) {
          sl.calib = stats.totalCharacters / stats.outputTokens;   // c2t 自校准：该子代理完成轮的真实比例
          sl.st = "calib";
        }
        subRateRecompute();
        /* 回调跑在宿主 store 的通知分发里，异常会冒进宿主其它订阅者（泵入口对 render 同款包裹） */
        try { updateLive(); } catch (e) { FATAL.subLiveErr = String((e && e.stack) || e); }
      });
      sl.off = offFn;
      /* subscribeStore 会同步首调一次回调：首调即 reset（换代/sessionId 不匹配）时
       * h.dead 已置位，offFn 是悬挂订阅的解绑函数——直接判 offFn 会把它当成功绑定
       * 写回（10Hz 重绑抖动 + 订阅泄漏，review P1）。按 h.dead 判定：显式释放 offFn
       * （幂等，兼带 dispose tracker），subSlotReset 自带 2s 节流防心跳空转。 */
      if (!offFn || h.dead) {
        if (offFn) { try { offFn(); } catch (e) { } }
        subSlotReset(sl);
      }
    }
    function sideHandleValid(handle) {
      if (!handle || handle.dead) return false;
      var sid = instSid || pickedSid || "";
      if (handle.sideKey === null) return sid === handle.sid;   // v174：主分栏也校验会话——切会话后、下次 bridgeTick 重绑前不得读旧 tracker
      var scope = readPaneScope(wantedEl, sid, pid);
      var key = scope && JSON.stringify([scope.sid, scope.identity, scope.workspacePath, scope.remoteSessionId]);
      return sid === handle.sid && key === handle.sideKey;
    }
    function bridgeTick() {
      if (inactive()) return;
      if (!state.rateLine || !TURN_STATS) { bridgeDetach(bridge.handle); updateLive(); return; }
      var sid = instSid || pickedSid || "";
      if (!sid) { bridgeDetach(bridge.handle); updateLive(); return; }
      /* v174：辅助对话实例必须有可信 scope（桥属性在位且校验通过）才绑 store——registry
       * 按 (remote, workspace) 精确匹配，匹配不到就保持 DB 降级；无 scope 时不猜归属。 */
      var sideScope = null;
      if (String(pid).indexOf("selection-side-chat:") === 0) {
        /* pickedSid 在首轮 render 前可能滞后（bootstrap 窗口），回退 instSid 与 heavy 同语义 */
        sideScope = readPaneScope(wantedEl, pickedSid || instSid, pid);
        if (!sideScope || sideScope.identity !== "" || sideScope.remoteSessionId !== "") {
          bridgeDetach(bridge.handle); updateLive(); return;
        }
      }
      var sideKey = sideScope ? JSON.stringify([sideScope.sid, sideScope.identity, sideScope.workspacePath, sideScope.remoteSessionId]) : null;
      if (bridge.handle) {
        if (bridge.handle.sid === sid && bridge.handle.sideKey === sideKey) {
          var cur = null;
          try { cur = bridge.handle.store.getState(); } catch (e) { }
          var snap = cur && cur.snapshot;
          /* 绑定健康：store 可能在工具执行期间（查阅/编辑等）很久不推新快照——
           * 仍按本轮 2s 心跳刷新一次，让「已观察 Xs」能继续走字，而不是整段
           * 工具执行时间里界面像冻住；updateLive 内部按文本/类名是否真变化
           * 做了去重写入，这里多调用一次不会造成多余的 DOM 抖动。 */
          if (snap && snap.sessionId === bridge.handle.sid) { updateLive(); return; }
        }
        bridgeDetach(bridge.handle);   // pane 切会话 / store 关闭或换代：释放后重绑
      }
      var store = zuTryBindStore(sid, sideScope && {
        identity: sideScope.identity, workspacePath: sideScope.workspacePath, remoteSessionId: sideScope.remoteSessionId,
      });
      if (!store) { updateLive(); return; }   // 无桥 / 无匹配 session：降级（DB 路径不变），下轮再探
      var tracker = TURN_STATS.createTracker();
      var handle = { dead: false, sid: sid, sideKey: sideKey, store: store, tracker: tracker, alias: {}, off: null, charsPerToken: null, bornAt: Date.now() };
      var off = TURN_STATS.subscribeStore(store, tracker, function () {
        if (inactive() || handle.dead) return;
        if (!sideHandleValid(handle)) { bridgeDetach(handle); updateLive(); return; }
        var st = null;
        try { st = store.getState(); } catch (e) { st = null; }
        var snap = st && st.snapshot;
        if (!snap || snap.sessionId !== sid) { bridgeDetach(handle); updateLive(); return; }   // 换代/关闭：下轮 tick 重绑
        var rows = snap.rows && snap.rows.window;
        if (Array.isArray(rows)) {
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (r && typeof r.turnId === "string") handle.alias[r.turnId] = r.productTurnId || r.turnId;
          }
        }
        bridge.turnId = zuActiveTurnId(snap);
        /* 同上：宿主 store 通知分发内的回调不留异常出口 */
        try { updateLive(); } catch (e) { FATAL.bridgeLiveErr = String((e && e.stack) || e); }
      });
      if (!off) {   // store 接口不合约定：退回降级
        try { store.off(); } catch (e) { }
        tracker.dispose();
        updateLive();
        return;
      }
      /* 首次同步回调可能已解绑；此时 off 尚未保存，必须释放悬挂订阅。 */
      if (handle.dead) { try { off(); } catch (e) { } updateLive(); return; }
      handle.off = off;
      bridge.handle = handle;
      bridge.rebinds = (bridge.rebinds || 0) + 1;   // 诊断：本 pane 实例绑定/重绑次数
      updateLive();   // subscribeStore 首次同步回调已 ingest 初始快照，这里补挂实时段
    }
    function updateLive() {
      /* v73：合并「生成速度」chip 后，桥数据持续存在（生成中→完成，同一套
       * ico+'<span class="zu-live CLS">'+TEXT 结构）时只原地改 textContent/className，
       * 不重建条面（v33 原则）；桥「有/无」切换才会改变 chip 结构（图标出现/消失、
       * 退回 DB 的两段式拼接），需要整条重渲染。 */
      var h = bridge.handle;
      if (h && !sideHandleValid(h)) { bridgeDetach(h); h = null; }
      var stats = (state.rateLine && h && !h.dead && bridge.turnId) ? h.tracker.get(bridge.turnId) : null;
      /* v87：绑定成功但 turnHeader 还没到——桥活着就别让 chip 空着，按绑定时长合成
       * "思考中"，turnHeader 到位后自然切换为真实统计。v116 条件按宿主源码收紧：
       * ① control.phase==="running"（verifier/长轮 header 滑出，轮真的在跑）；
       * ② 显式 phase==="draft" 且窗口为空（新会话空窗，v87 本意）。宿主 wire 快照
       * rows.window 恒为全序尾 60 行（PROTOCOL_V4_LIMITS.snapshotTailWindowRows），
       * 末轮行数超窗口的闲置会话整窗没有 turnHeader——旧条件「行非空」会让这类会话
       * 永久合成"思考中"（用户停了任务还亮着、切走切回每次重绑重新计时）；而
       * phase=running 与 turnHeader 行同批到达，「行非空且非 running」不存在合法瞬态。
       * control 缺失或 phase 未知的旧形状一律不合成（字段缺失是常态不是错误）。 */
      if (!stats && h && !h.dead && bridge.handle && h.store) {
        try {
          var st0 = h.store.getState();
          var snap0 = st0 && st0.snapshot;
          if (snap0 && snap0.sessionId === h.sid) {
            var rows0 = snap0.rows && snap0.rows.window;
            var ph0 = snap0.control && snap0.control.phase;
            if (ph0 === "running" || (ph0 === "draft" && rows0 && !rows0.length)) {
              stats = { complete: false, characterRate: null, runningTool: null,
                        phase: "thinking", observedMs: Math.max(0, Date.now() - (h.bornAt || Date.now())),
                        observedLive: true, totalCharacters: 0 };
              bridge.turnId = bridge.turnId || "";
            }
          }
        } catch (e) { }
      }
      if (h && stats && stats.complete && stats.outputTokens > 0 && stats.totalCharacters > 0) {
        h.charsPerToken = stats.totalCharacters / stats.outputTokens;   // c2t 自校准：本轮真实比例供下一轮估算用
      }
      subRateTick(stats && !stats.complete ? stats.runningSubagents : null);   // 运行中子代理逐个绑/解速率桥
      renderSubAgentRows();   // v176：Agent 行内速率 chip 对账（槽位估算/快照真实值两态）
      var wasLive = liveKindCur === "live";
      var view = stats ? zuBarSpeedView(stats, h && h.charsPerToken, subRate.sum,
        /* 本 pane 会话行（render 缓存），不取 payload 顶层 session——那是全局最近活跃
         * 会话，多窗/分栏下会把别的会话的会话均串进本格（v181 补修）。 */
        (lastView && lastView.session && typeof lastView.session.avg_tps === "number" &&
         isFinite(lastView.session.avg_tps) && lastView.session.avg_tps > 0) ? lastView.session.avg_tps : 0) : null;
      liveStatsCur = stats;
      if (state.theme === "compact") { syncTpsChip(); return; }   // v146：精简模式速率走工具行 chip（10Hz 心跳原地跟随，条面不重建）
      // 用 view（而非 stats）判定快速路径：stats 非空但 view 为 null（历史存量，见
      // zuBarSpeedView）时结构要切回降级拼法，必须走下面的整条重渲染，不能原地改字。
      // 阶段（思考↔工具↔正文）切换会更换 chip 的图标（动效脑/闪电），同样只能整条
      // 重渲染——原地改字换不了图标。
      var phase = view && view.phase ? view.phase : "";
      if (view && wasLive && phase === livePhaseCur) {
        liveTextCur = view.text;
        if (!liveEl) { render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 }); return; }
        if (liveEl.textContent !== view.text) liveEl.textContent = view.text;
        liveIconCur = phase === "thinking" ? "think" : phase === "tool" ? "tool" : phase ? "generate" : "bolt";
        var cls = "zu-live " + view.cls + (view.word ? " zu-shimmer" : "");
        if (liveEl.className !== cls) liveEl.className = cls;
        /* v97：子代理速率是渲染端实时状态（不在泵快照里），tooltip 里的逐子代理
         * 行随原地改字一起刷新——内容签名没变时 drawTip 幂等只调位置，不闪烁。 */
        var tip1 = buildLiveTip(view);
        var liveCell = liveEl.closest ? liveEl.closest(".it") : null;
        if (liveCell && liveCell.__tip !== tip1) {
          /* v224 修复：__tip 宿主与 drawTip 读取都在 .it 格元素上（render 挂 tips[i]、
           * drawTip 读 tipFor.__tip）——v218 只改了 tipFor 判定，新串仍写到格内
           * .zu-live span：条件每 tick 命中、重画的却始终是整条渲染时挂在格上的旧串，
           * 悬停中「当前读数」冻结在最后一次整条渲染的值（实测 chip 已跳动、tooltip
           * 还停在「思考中…2秒」）。改写回格元素：悬停中每 tick 跟手，未悬停也新鲜。
           * v232：键盘焦点在柱状图柱上时只保鲜 __tip 不重画（innerHTML 换掉聚焦柱会
           * 丢焦点），焦点移出后下一 tick 恢复跟手；ownerDocument 取 activeElement，
           * 不引用全局 document（updateLive 切片沙箱无 document）。 */
          liveCell.__tip = tip1;
          var aeDoc = liveCell.ownerDocument;
          var ae = aeDoc ? aeDoc.activeElement : null;
          /* v254：V2 双 Tab / 维度下拉 / 柱 hover 交互后短冻结 600ms——updateLive 每
           * 100ms 重编整卡会打断下拉展开、Tab 点击与柱间平滑切换（焦点不在 tip 内时
           * 现有守卫不覆盖）。冻结期只保鲜 __tip 不重画，退出后下一 tick 自然跟手。
           * v263：悬停保活（mouseInBar）同样冻结——生成中估算/思考计时走字让 tipSig
           * 每 tick 变化、innerHTML 整卡重建，不仅打断交互（Tab 已提前到 pointerdown
           * 兜底），悬停中整卡每秒重绘也闪烁。指针停在 tooltip 上时数字冻结在进入
           * 时刻，离开后下一 tick 恢复跟手。 */
          var v2Freeze = (typeof speedInteractAt !== "undefined" && speedInteractAt &&
            Date.now() - speedInteractAt < 600) ||
            (typeof mouseInBar !== "undefined" && mouseInBar);
          if (tipFor === liveCell && !v2Freeze && !(ae && ae.closest && ae.closest(".zu-sc-col"))) drawTip(liveCell, true);
        }
        return;
      }
      liveTextCur = view ? view.text : "";
      render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 });
    }
    /* v90：心跳 0.5s→0.1s——0.5s 秒数走字仍有可感卡顿；render 有 lastHtml 幂等守卫，
     * 内容未变时仅字符串构建+比较、不写 DOM，10Hz 空转无性能顾虑。扫描 tick 保持 0.5s。 */
    bridge.timer = setInterval(bridgeTick, 100);
    bridgeTick();

    function render(d) {
      /* v262：只有真实快照帧才更新共享数据。空对象兜底渲染（实例 spawn 首渲染/桥空窗的
       * `render(state.data || {session:{},...})`）若覆盖 state.data，会把统一轮表连同整帧
       * 抹掉——下一次 hover 的整条渲染读不到 speed_history，走 fb-html 旧版整卡（v261
       * spdRender 实证 hasH:false，正是「老会话旧卡、新会话正常」的根因）。真帧自有
       * __zusageUpdate 外层写入，这里条件写只防回退，渲染本身仍按入参 d 照常执行。 */
      if (d && d.session && d.session.sid) state.data = d;
      var pc = null, p = null;
      if (instSid) {
        /* v61.1 分屏多实例：本条显示哪个会话由 composer 祖先链的 data-session-id 决定
         * （客户端每个 pane 自带该标记，比窗口级 mine 更准，绝不串 pane）；
         * 会话不在池里（还没拉取）就显示本会话 0 值 —— 绝不回退到别的会话（v34 原则）。 */
        pickedSid = instSid;
        p = sessionFor(d, instSid, pid);
        if (!p) p = stubFor(instSid);
      } else if (String(pid).indexOf("selection-side-chat:") === 0) {
        /* v174：辅助对话无可信 child sid（宿主缺 data-session-id 标记的窗口期）时，
         * 绝不借窗口焦点（mine）或最近会话（pickCurrent）——身份未知显示空 stub，
         * 等协调器补上会话标记后自然恢复。 */
        pickedSid = "";
        p = stubFor("");
      } else {
        var mine = d.mine;   // 泵按窗口注入：string=本窗口焦点会话（空串=该窗口当前无会话），undefined=泵无该窗口信息
        if (typeof mine === "string") {
          pickedSid = mine;
          window.__zusageWantSid = mine;
          if (mine) {
            p = sessionFor(d, mine, pid);
            if (!p) p = stubFor(mine);
          } else {
            p = stubFor("");
          }
        } else {
          pc = pickCurrent(d);
          p = pc ? pc.sess : null;
          pickedSid = p ? p.sid : "";
          window.__zusageWantSid = (pc && pc.want) || "";   // 泵读取后让 zusage.py 强制纳入该会话
          if (!p) p = stubFor((pc && pc.want) || "");
        }
      }
      excOn = excActive(p);   // 气泡的显示依据（track 每帧消费）
      lastBand = ctxBandOf(p);   // v92：原生上下文按钮增强的数据源（与状态条上下文格同口径）
      /* 实时 pane 模型优先；没有宿主标记的旧版本才使用最近已完成请求。 */
      readQuotaSelection();
      quotaProvider = quotaSelection ? quotaSelection.providerId : ((p.last && p.last.provider_id) || "");
      quotaModel = quotaSelection ? quotaSelection.modelId : ((p.last && p.last.model) || "");
      quotaFallback = typeof d.provider_fallback === "string" ? d.provider_fallback : "";
      reportQuotaSelections();
      quotaSourceId = "";
      lastQuotaAll = d.quota && typeof d.quota === "object" ? d.quota : null;
      lastResets = lastQuotaAll && lastQuotaAll.resets && typeof lastQuotaAll.resets === "object" ? lastQuotaAll.resets : null;   // v135：重置卡独立字段（旧主进程无则 fail-closed 不渲染）
      if (lastQuotaAll && lastQuotaAll.sources) {
        var qprov = effectiveQuotaProvider();
        var qsid = "";
        if (qprov.indexOf("account:") === 0) {
          if (qprov.indexOf("account:bigmodel-start-plan") === 0 || qprov.indexOf("account:zai-start-plan") === 0) qsid = "zcode-start";
          else qsid = qprov.indexOf("bigmodel") >= 0 ? "bigmodel" : (qprov.indexOf("zai") >= 0 ? "zai" : "");
          /* 未知 account 档不退 active（可能显示他窗自定义源）；team 变体由上方静态提示分支承接 */
        } else if (lastQuotaAll.byProvider && lastQuotaAll.byProvider[qprov]) {
          qsid = lastQuotaAll.byProvider[qprov];   // 自定义 provider：只认主进程显式映射
        }
        quotaSourceId = qsid;
        lastQuota = qsid ? (lastQuotaAll.sources[qsid] || null) : null;
      } else if (lastQuotaAll) {
        /* 旧主进程平铺协议：数据归属未知。内置 account 档按 family 接受（v96 语义即主进程
         * 只查内置套餐）；自定义 provider 无法证明归属 → fail-closed 不显示。 */
        var fp = effectiveQuotaProvider();
        lastQuota = (fp.indexOf("account:") === 0 && fp.indexOf("team") < 0) ? lastQuotaAll : null;
      } else lastQuota = null;
      /* v12 多服务器：remote_today/remote_errors 按目标键分组，取本会话所属主机的分片；
       * 旧格式（单目标，顶层对象即 today）兜底兼容。 */
      var myTarget = p.remote_target || "";
      var remoteToday = null;
      if (p.remote && d.remote_today && typeof d.remote_today === "object") {
        remoteToday = typeof d.remote_today.requests === "number" ? d.remote_today
          : (myTarget && (d.remote_today[myTarget] || remoteTodayCache[myTarget])) || null;
      }
      var view = {
        session: p, last_turn: p.last_turn || {}, last: p.last || {},
        /* v9：远端会话的「今日合计」用远端机数据，本地 today 只在显示本地会话时使用 */
        today: p.remote ? (remoteToday || {}) : d.today,
        native_ctx: nativeCtxVal,
        context_window: p.context_window, context_auto: p.context_auto,
        code: p.code, ctx_exc: p.ctx_exc, tools: p.tools,
        remote: !!p.remote, remote_host: p.remote_host || "", remote_error: p.remote_error || (d.remote_errors && myTarget && d.remote_errors[myTarget]) || (!d.remote_errors && d.remote_error) || "",
        /* v62（issue #14 / #10）：该会话不在本地库且没命中远端 → 条面给一次配置指引，
         * 把"各项全 0 = 插件坏了"的误判转成可执行的下一步；远端命中的会话由 ☁ 徽标那套说明。 */
        not_local: (d.not_local || []).indexOf(p.sid) >= 0 && !p.remote,
        remote_enabled: !!d.remote_enabled,
        remote_stale: !!p.remote_stale,
        remote_empty: !!(p.remote && !p.requests && !p.remote_missing),
        sub: p.sub || {requests: 0, total: 0, input: 0, output: 0, cache_read: 0, active: false, list: []},
      };
      lastSub = view.sub;   // 子代理明细面板的数据源（开关面板/数据推送刷新用）
      lastView = view;   // v146：精简模式速率 chip 的 tooltip 摘要数据源
      refreshWants();
      if (state.theme === "compact" && main.children.length) {
        /* v146 精简模式：不重建条面（条已 display:none），但数据解析（lastBand/quota 选择/
         * reset 字段）照跑——它们是原生按钮增强与额度/重置卡 chip 的数据源；速率 chip 在
         * 此同步（DB 值随推送刷新），子代理明细面板开着时照常跟随。
         * v156：条面空壳（热更占位/清子树后未填过）时不短路，先补一次完整渲染——条隐藏时
         * 渲染不可见，但切回默认时才不会露出空壳细线。 */
        subPopFollowPush(view);
        enhanceCtxButton();
        enhanceQuotaChip();
        enhanceModelPuller();
        enhanceGitChip();
        syncTpsChip();   /* v177：恢复 v146 短路内调用——2976478 挪到公共尾部后短路 return 到不了，
                          * 泵推送的最坏 600ms 延迟落在速率 chip 上且与 git chip 不对称 */
        return;
      }
      var h = html(view);
      /* 内容没变就不重建 DOM：泵每 1.5s 推送一次，无条件 innerHTML 会重建条面+重启呼吸灯
       * 动画+触发 tooltip 重画 = 悬停时周期性闪烁（v33 修复）。变化时才重建。 */
      var focusedIndex = -1;
      if (document.activeElement && main.contains(document.activeElement)) focusedIndex = Array.prototype.indexOf.call(main.querySelectorAll(".it"), document.activeElement);
      var restoreFocusTip = focusedIndex >= 0 && tipFor === document.activeElement;
      var previousTip = tipFor;
      var didRebuild = h.s !== lastHtml;
      if (didRebuild) {
        lastHtml = h.s;
        main.innerHTML = h.s;
      }
      var els = main.querySelectorAll(".it");
      for (var i = 0; i < els.length; i++) els[i].__tip = h.tips[i] || null;
      if (didRebuild && focusedIndex >= 0) {
        var nextFocus = els[focusedIndex];
        if (nextFocus && nextFocus.focus) {
          restoringFocus = !restoreFocusTip;
          if (restoreFocusTip) tipFor = null;
          try { nextFocus.focus(); } finally { restoringFocus = false; }
        }
        if (!restoreFocusTip && previousTip) tipFor = previousTip;
      }
      liveEl = main.querySelector(".zu-live");   // v71：条面重建后实时段节点重挂（原地更新用）
      /* 数据刷新时正在悬停：接管同位置的新元素继续显示。只调位置不重画内容——
       * 数字每 1.5s 都在变，重画就是闪烁；旧文本保持到鼠标下次移动为止。 */
      if (tipFor) {
        var nu = null;
        if (tipFor === main) nu = main;
        else if (tipFor.__n === els.length) nu = els[tipFor.__idx];
        if (nu && nu.__tip) {
          tipFor = nu;
          if (nu !== main) { nu.__idx = Array.prototype.indexOf.call(els, nu); nu.__n = els.length; }
          if (nu.setAttribute) nu.setAttribute("aria-describedby", tip.id);
          /* v232：速度卡在悬停中随快照跟手（新段完成即重画柱状图；悬停段下标编在串里，
           * 重建不丢高亮）。焦点/选择在 tip 内时跳过防打断——drawTip 自带签名幂等与
           * 选区守卫，内容没变不会真重建。 */
          var focusInTip = tip.contains(document.activeElement);
          var speedFollow = !!(nu.__tip.indexOf && nu.__tip.indexOf("zu-stat-tip--speed") > 0) && !focusInTip;
          /* v242:pill 主题同样受「焦点在 tip 内跳过重绘」守卫——此前无条件 drawTip,
           * 键盘聚焦柱体时一次快照推送就把焦点打回 body(v224 修的是悬停链,此处补齐焦点链) */
          if (!focusInTip && (state.theme === "pill" || document.activeElement === nu || speedFollow)) drawTip(nu, true);
          else positionTip(nu, true);
        } else if (lastPt.x >= 0 && (function () {
          /* v265：接管失败（条目结构随 phase 切换变化）但指针仍悬停在 tooltip 覆盖
           * 区内——保留旧内容原地显示，指针一动即由 mousemove 重新判定该显示什么；
           * 此前直接收掉，生成中 phase 切换（思考↔工具↔正文每次整条重建条面）会让
           * 悬停中的 tooltip 闪断、点击 Tab 落在消息区。 */
          var tr = tip.getBoundingClientRect();
          return lastPt.x >= tr.left && lastPt.x <= tr.right && lastPt.y >= tr.top && lastPt.y <= tr.bottom;
        })()) { positionTip(tipFor, true); }
        else hideTip(false, "render-orphan");
        /* 接管失败（条目结构变化）也受总闸保护：鼠标仍在条上时保持旧 tooltip，
         * 下一次 mousemove 会重新判定该显示哪一项 */
      }
      subPopFollowPush(view);   // v217：统一浮层开着时随推送刷新（会话切换即关，入口重建即重绑）
      enhanceCtxButton();   // v92：数据点 reapply（React 数据更新重写 dasharray 后兜回）
      enhanceQuotaChip();   // v96：额度 chip 数据点 reapply
      enhanceModelPuller();   // v132：宿主设置页「拉取模型」按钮 reapply
      enhanceGitChip();     // v96：同点对账 Git chip（开关/会话切换/scope 变化在此收敛）
      syncTpsChip();        // v155：速率 chip 数据点 reapply（compact 短路与空壳直通两路都经此）
    }


    /* ---------- 自绘 tooltip：向上弹出（原生 title 方向不可控） ---------- */
    var tipFor = null, lastMoveAt = 0, tipSig = "", restoringFocus = false;
    var lastPt = { x: -1, y: -1 };   // v265：节流前的最近指针位置（接管失败时判指针是否仍在 tip 覆盖区内）
    var lastTipDownAt = 0;   // v271：最近一次 tip 内按压时刻——按压后 1.2s 硬保活窗
    var speedRebuildPending = 0;   // v275：待合并的整卡重编 rAF 句柄
    var mouseInBar = false;   // 鼠标是否悬停在条面/tooltip/面板上（最近一次 mousemove 判定）
    var tipGraceTimer = 0;    // 越顶宽限定时器（v46）
    var tipStats = { mv: 0, shows: 0, hides: 0, last: "", lastHide: "", corridor: 0, grace: 0, hideSeq: [] };   // v275：hideSeq 最近 8 次收起原因（诊断偶发关闭）   // 诊断：随 mount diag 回写
    /* v249 点击激活（zusage3.tipClick，缺省关=即时悬停原语义）：开关开启后悬停不再打开
     * 统计卡/子代理 preview，打开一律走 bar.click；focusTipAt 记录 focusin 刚打开 tooltip
     * 的时刻——点击 .it 会先 focusin 再 click，无此标记首击会被「再点关闭」分支立即抵消。
     * v247 的 1000ms 停留定时器链已整体移除（用户裁定：开关关闭不做停留延迟）。 */
    var focusTipAt = 0;
    /* 隐藏总闸（v33.3）：鼠标还在条面上时，任何路径（数据刷新接管失败/输入框重建/
     * 瞬时不可见判定）都不得隐藏 tooltip——只有鼠标真正离开条面（left-bar，force）
     * 或条面整体隐藏（force）才允许。 */
    function hideTip(force, cause) {
      /* v271：tip 内按压后 1.2s 硬保活——点击/按压引发的焦点跌落、宿主重渲染、
       * 命中区边缘误判（left-bar）等任何 force 收起都不得关掉用户正在交互的
       * tooltip（用户实报「点击 tooltips 中的任何位置都会导致关闭」）；win-leave
       * （窗口真失焦）与 Escape 例外。typeof 守卫兼容切片沙箱。 */
      if (force && cause !== "win-leave" && cause !== "escape" &&
          typeof lastTipDownAt !== "undefined" && lastTipDownAt &&
          Date.now() - lastTipDownAt < 1200) force = false;
      if (!force && mouseInBar) { tipStats.lastHide = "blocked:" + (cause || "?"); return; }
      if (tipGraceTimer) { clearTimeout(tipGraceTimer); tipGraceTimer = 0; }
      if (tip.style.display !== "none") tip.style.display = "none";
      if (tipFor && tipFor.removeAttribute) tipFor.removeAttribute("aria-describedby");
      tipFor = null;
      tipSig = "";
      hideFxTip();   // 主 tooltip 收起时费用说明小气泡必无依附，同步收
      tipStats.hides++;
      tipStats.lastHide = cause || "?";
      tipStats.hideSeq.push(cause || "?");
      if (tipStats.hideSeq.length > 8) tipStats.hideSeq.shift();   // v275：诊断偶发关闭
    }
    function positionTip(el, keepTop) {
      var tr = tip.getBoundingClientRect(), ar = el.getBoundingClientRect();
      var left = ar.left + ar.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, Math.max(8, innerWidth - tr.width - 8)));
      /* keepTop=数据刷新等重定位时保持顶边——悬停中只调位置不重建，顶边不动鼠标就
       * 不会因盒形变化被甩出去（外面是 iframe 静默区，甩出去就回不来了）。
       * 只有首次弹出才按条目重新锚定（悬空 8px）。 */
      var top = (keepTop && tip.style.top) ? parseFloat(tip.style.top) : 0;
      if (!isFinite(top) || top < 8) top = Math.max(8, ar.top - tr.height - 8);
      /* v214：展开/数据变化后高度增长时钳底边（keepTop 只保顶边会越出窗口） */
      if (top + tr.height > innerHeight - 8) top = Math.max(8, innerHeight - tr.height - 8);
      tip.style.left = Math.round(left) + "px";
      tip.style.top = Math.round(top) + "px";
    }
    function drawTip(el, keepTop) {
      var t = el && el.__tip;
      if (!t) { tip.style.display = "none"; tipFor = null; return; }
      /* 幂等：内容没变就只调位置，不重建 innerHTML（重建=悬停中每 1.5s 闪烁） */
      if (t === tipSig && tip.style.display === "block") {
        positionTip(el, true);
        return;
      }
      var selection = null;
      try { selection = window.getSelection && window.getSelection(); } catch (e) { }
      if (keepTop && selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode &&
          tip.contains(selection.anchorNode) && tip.contains(selection.focusNode)) { positionTip(el, true); return; }
      var oldBody = tip.querySelector ? tip.querySelector(".tbody") : null, oldScroll = keepTop && oldBody ? oldBody.scrollTop : 0;
      var oldChartL = 0;
      if (keepTop && oldBody) { var oc = oldBody.querySelector(".zu-sc-wrap"); oldChartL = oc ? oc.scrollLeft : 0; }
      tipSig = t;
      hideFxTip();   // innerHTML 重建会换掉 ? 图标节点，旧气泡悬挂无依附——先收
      tip.innerHTML = '<div class="tbody"></div>';
      /* v167：带模型明细的两个 tooltip 放宽宽度帽（取最宽一行），其余不变 */
      tip.classList.toggle("zu-tip-wide", t.indexOf("rt-models") > 0);
      if (t.charCodeAt(0) === 1) tip.firstChild.innerHTML = t.slice(1);   // \x01 前缀 = 结构化 HTML（v67.1）
      else tip.firstChild.textContent = t;
      tip.firstChild.scrollTop = oldScroll;
      var nc = tip.querySelector(".zu-sc-wrap");
      if (nc && oldChartL) nc.scrollLeft = oldChartL;   // v232：速度图表横滚位置跨重建保留
      tip.style.display = "block";
      positionTip(el, keepTop);
    }
    function showTipFor(el) {
      if (tipFor && tipFor !== el && tipFor.removeAttribute) tipFor.removeAttribute("aria-describedby");
      tipFor = el;
      if (el.setAttribute) el.setAttribute("aria-describedby", tip.id);
      var its = main.querySelectorAll(".it");
      el.__idx = el === main ? -1 : Array.prototype.indexOf.call(its, el);
      el.__n = its.length;   // render 接管时校验条目数未变，数量变了 __idx 就不可信
      tipStats.shows++;
      tipStats.last = el === main ? "main" : String(el.textContent || "").slice(0, 12);
      drawTip(el, false);
    }
    main.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); hideTip(true, "escape"); }
    });
    main.addEventListener("focusin", function (e) {
      if (inactive() || restoringFocus || panel.classList.contains("open")) return;
      var item = e.target && e.target.closest ? e.target.closest(".it") : null;
      if (!item || !main.contains(item)) return;
      /* v232 顺带修 v217 回归：.zu-sub 走统一浮层后 __tip 恒 null，滚入判定若被
       * __tip 早退拦截，药丸窄条下子代理入口键盘聚焦不再滚入可视区（pill 夹具实测
       * scrollLeft 恒 0）。滚入只依赖条目矩形，提到 __tip 早退之前。 */
      if (state.theme === "pill" && (item.__tip || item.classList.contains("zu-sub"))) {
        var ir = item.getBoundingClientRect(), mr = main.getBoundingClientRect();
        if (ir.left < mr.left) main.scrollLeft -= mr.left - ir.left;
        else if (ir.right > mr.right) main.scrollLeft += ir.right - mr.right;
      }
      if (!item.__tip) return;   // v217：无 tooltip 的入口（.zu-sub）不进通用 tooltip 链
      mouseInBar = true;
      cancelTipGrace();
      if (item !== tipFor) { showTipFor(item); focusTipAt = Date.now(); }
    });
    main.addEventListener("focusout", function (e) {
      var next = e.relatedTarget;
      if (next && main.contains(next) && next.closest && next.closest(".it")) return;
      if (next && tip.contains(next)) return;   // v214：焦点进入浮层卡片（项目卡按钮等）不关闭
      /* v263：tip 内控件（V2 Tab）点击会同步重编整卡 innerHTML，被点按钮 detach 使焦点
       * 跌落 body——鼠标仍悬停在条面/tooltip 上时这不是「焦点离开」：保住 mouseInBar
       * 并降级为非 force（总闸拦截），指针真正移开由 mousemove 判定收起。否则点击 Tab
       * 的瞬间 tooltip 被强制关掉，切换生效了用户也看不见（「Tab 点击无效」的第二根因，
       * 旧版 click-only 同样中招）。纯键盘（mouseInBar 已 false）维持原强制关闭。 */
      /* v271：tip 内按压后 1.2s 内的焦点跌落（点击空白聚焦 body）直接不关 */
      if (typeof lastTipDownAt !== "undefined" && lastTipDownAt &&
          Date.now() - lastTipDownAt < 1200) return;
      if (mouseInBar) { hideTip(false, "focus-leave"); return; }
      mouseInBar = false;
      if (tipFor) hideTip(true, "focus-leave");
    });
    /* v117 悬停命中区扩到整栏：条目间空隙/分隔符按 sep 中线就近归入左右条目，尾部空隙归
     * 末位条目（.zu-main 默认 space-between + sep 对称 margin，sep 中线恰为相邻条目命中区的
     * 精确分界；v226 水平对齐改居左/居右后依据不变——hitItemFor 按 sep 实际 rect 中线归属，
     * 任何对齐下都成立）。⚙ 在 .zu-main 之外不受影响；空条面与 __tip 缺失的兜底目标返回 null，
     * 维持 v33.2 的"保持当前 tooltip"。 */
    function hitItemFor(t, x) {
      var el = t.closest(".it");
      if (el || !t.closest(".zu-main")) return el || null;
      var its = main.querySelectorAll(".it"), seps = main.querySelectorAll(".sep");
      for (var i = 0; i < seps.length; i++) {
        var sr = seps[i].getBoundingClientRect();
        if (x < (sr.left + sr.right) / 2) return its[i] || null;
      }
      var last = its.length ? its[its.length - 1] : null;
      return (last && last.__tip) ? last : null;
    }
    /* 事件挂 document 捕获阶段（v32）：React/应用层可能在冒泡路上 stopPropagation，
     * 挂 main 的 mousemove 收不到（v31 实证：原生 title 有 hover、自绘 tip 无事件）。
     * stale() 守卫：热更新后旧实例监听器必须罢工，否则新旧两个 tip 同时工作。 */
    listenGlobal(document, "mousemove", function (e) {
      if (inactive()) return;
      if (typeof lastPt !== "undefined") { lastPt.x = e.clientX; lastPt.y = e.clientY; }   // v265：节流前记录，供接管失败判定（v267 typeof 守卫兼容 mousemove 切片沙箱）
      var mt = e.target;
      /* v227：预估费用说明小气泡（fxTip，body 级单例）悬停保活。气泡挂在主 tip/subPanel
       * 之外（tip 上方或覆盖其上），指针移入即落进下方「条外」分支被按 left-bar 强制收
       * 主 tip（hideTip 同步收气泡，v202 起悬停说明气泡即被拖杀）；子代理面板路径则被
       * preview-leave 倒计时收走面板。视同仍在 tooltip 上：先于 150ms 节流，停在气泡里
       * 不动也持续保活（同 subPop 进出判定放节流前的理由）。 */
      if (mt && mt.closest && fxTip.style.display === "block" &&
          (mt === fxTip || (fxTip.contains && fxTip.contains(mt)))) {
        mouseInBar = true;
        cancelTipGrace();
        subPopCancelHide();
        return;
      }
      /* v217 统一子代理浮层：进出判定先于 150ms 节流（preview 离开要跟手）；
       * pinned 不受鼠标影响，浮层/入口内移动取消延迟关闭 */
      if (subPopOpen()) {
        if (mt && mt.closest && (mt.closest(".zu-sub-pop") || mt.closest(".zu-sub"))) subPopCancelHide();
        else subPopScheduleHide();
      }
      tipStats.mv++;
      if (Date.now() - lastMoveAt < 150) return;
      lastMoveAt = Date.now();
      var t = e.target;
      if (!t || !t.closest) return;
      if (tip.contains(t)) { mouseInBar = true; cancelTipGrace(); return; }   // 鼠标移入 tooltip：保持
      if (t.closest(".panel")) {
        /* 面板上不保留条面 tooltip（v42）：开设置的路上触发过条目 tooltip 的话，
         * 这分支若不清掉它，鼠标在面板里它就永不消失。 */
        mouseInBar = true;
        if (tipFor) hideTip(true, "panel-hover");
        return;
      }
      if (!bar.contains(t)) {
        /* 空中走廊（v45）：悬空缝是"条外且 tip 外"的真空带，采样事件落在这里会被误判
         * 成"移开"立即熄灭——鼠标在 tooltip 横向范围、底边下方 ~12px 内时视同仍在条上，
         * 穿行去 tooltip 点 tab 的路上不熄灭。 */
        if (tipFor && inTipCorridor(e.clientX, e.clientY)) {
          tipStats.corridor++;
          mouseInBar = true;
          cancelTipGrace();
          return;
        }
        /* 越顶宽限（v46）：mousemove 有 150ms 节流采样，快速上移时两个采样点之间能跨过
         * 整个 tooltip，采样点落在 tip 上方的死区——此前立即隐藏就把"正要进 tip"错杀成
         * "离开"。改挂 300ms 宽限：下一个采样落回 tip/走廊就取消（tip 仍可点 tab），
         * 确实继续远离才真正收起。横向/向下移出不享受宽限，依旧立即消失。 */
        if (tipFor && inTipColumn(e.clientX, e.clientY)) {
          tipStats.grace++;
          mouseInBar = true;   // 视同在途：总闸拦住 render-orphan 等路径趁机熄灯
          if (!tipGraceTimer) tipGraceTimer = setTimeout(function () {
            tipGraceTimer = 0;
            hideTip(true, "grace-expire");
          }, 300);
          return;
        }
        mouseInBar = false;
        if (tipFor) hideTip(true, "left-bar");   // v43：移开条面立即消失，不再留 300ms 缓冲
        return;
      }
      mouseInBar = true;
      cancelTipGrace();
      if (panel.classList.contains("open")) return;   // 面板开着：条面不弹 tooltip（弹出也会被面板盖住，只露边角）
      /* v249 点击激活：开关开启后悬停不再打开/切换统计卡与子代理 preview，打开一律走
       * bar.click；早退放在保活/收起分支之后——点开的 tooltip 仍靠上方分支保持与收起。
       * 开关关闭（缺省）= v246 即时悬停原语义，下方逻辑与 v246 逐行为一致。 */
      if (state.tipClick) return;
      /* v217：悬停子代理入口 → preview 打开统一浮层（显式关闭后的短暂抑制内不开）。
       * .zu-sub 的 __tip 为空不走通用 tooltip，命中判定在此处单独承接。 */
      if (subPopMode === "closed" && Date.now() >= subPopSuppressAt) {
        var se = t.closest(".zu-sub");
        if (se) { subPopShow(se, false); return; }
      }
      var el = hitItemFor(t, e.clientX);
      if (el) {
        if (el !== tipFor) showTipFor(el);
        else if (state.theme === "pill" && el.__tip !== tipSig) drawTip(el, true);
      } else if (tipFor) {
        /* 条面内非命中区（⚙ 本体与空条面）：保持当前 tooltip 不动（此处刻意无操作，v33.2）。
         * 条目间空隙/分隔符自 v117 起按 sep 中线就近切换（hitItemFor）；慢速移动的防闪烁
         * 不再依赖"空隙不动"，由 150ms 节流 + tipSig 幂等内容更新承担。 */
      }
    }, true);
    /* 鼠标甩出窗口外/窗口失焦：tooltip 立即收起（v43）。
     * v47 根因修正：ZCode 条面上方的聊天区是独立浏览上下文（iframe/webview，findComposer
     * 穿透同源 iframe 即佐证），光标从条面跨入其上时宿主文档会发 documentElement
     * mouseleave、且后续 mousemove 全部进子文档——diag 实证（mv 上万但 corridor/grace
     * 计数全 0、lastHide=win-leave）这就是"一向上移 tooltip 就消失"的根因：v43 把这种
     * 内部 leave 当成了甩出窗口。故 mouseleave 按退出点分流：
     *   · 退出点贴窗口边缘 = 真离开窗口 → 立即收；
     *   · 内部 leave 且退出点在 tip 横向列内（±30px）= 去 tooltip/回条面的穿行 → 400ms
     *     宽限（子上下文区域事件停摆，靠定时器兜底收回；tip/条面/走廊事件会取消它）；
     *   · 内部 leave 列外 = 横向走掉 → 立即收。 */
    function tipBoundaryHide() {
      if (inactive()) return;
      mouseInBar = false;
      if (tipFor) hideTip(true, "win-leave");
    }
    listenGlobal(window, "blur", tipBoundaryHide, true);
    function tipLeaveAt(x, y) {
      if (inactive() || !tipFor) return;
      if (x <= 1 || x >= innerWidth - 2 || y <= 1 || y >= innerHeight - 2) {
        tipBoundaryHide();
        return;
      }
      /* 伪边界过滤（v99）：Chrome 在悬停链收缩/重算时会补发 DOM 内部的 mouseleave
       * （Playwright 实测：滑过格内 .v↔.dim 的 flex 空隙时 documentElement 级必发、
       * tooltip 子元素之间连 tip 本体级都发，坐标在视口内、relatedTarget 是文档内存活
       * 元素）——指针并没有离开本文档。此前每次伪 leave 都按 v47 分流挂 400ms 宽限，
       * 鼠标随即停在格间空白/tooltip 上（无后续事件取消）→ tooltip「弹出后立即关闭」
       * （用户实测悬停「2.85万 1轮 1次」格内 万↔1 空隙必现；tooltip 本体停留同款熄灭）。
       * 事件坐标与 relatedTarget 都不可信（真进 iframe 时 relatedTarget=宿主 body、坐标
       * 也可能落在门外），改问活体：取触发时刻最深 :hover 元素——仍是本档具体元素即伪
       * leave，忽略交给 mousemove 流接管；截断到 body（空档区/已进子文档，v47 宽限语义）、
       * iframe/webview 或空链（甩出窗口）一律按真边界走原分流。 */
      try {
        var hs = document.querySelectorAll(":hover");
        var hovered = hs.length ? hs[hs.length - 1] : null;
        if (hovered && hovered !== document.body && hovered !== document.documentElement &&
            hovered.tagName !== "IFRAME" && hovered.tagName !== "WEBVIEW") return;
      } catch (e) { }
      var r = tip.getBoundingClientRect();
      if (x >= r.left - 30 && x <= r.right + 30) {
        tipStats.grace++;
        mouseInBar = true;   // 在途：总闸拦住 render-orphan 等路径趁机熄灯
        cancelTipGrace();
        tipGraceTimer = setTimeout(function () {
          tipGraceTimer = 0;
          hideTip(true, "grace-expire");
        }, 400);
      } else {
        mouseInBar = false;
        hideTip(true, "left-bar");
      }
    }
    listenGlobal(document.documentElement, "mouseleave", function (e) {
      tipLeaveAt(e.clientX, e.clientY);
    }, true);
    /* 光标离开 tooltip 本体：上行越顶/下行回条面 → 列内宽限；横向 → 立即收（分流同上） */
    tip.addEventListener("mouseleave", function (e) {
      tipLeaveAt(e.clientX, e.clientY);
    }, true);
    tip.addEventListener("mouseenter", function () {
      if (inactive()) return;
      cancelTipGrace();
    }, true);
    /* 空中走廊判定（v45）：tooltip 矩形横向 ±4px、纵向 tip 顶边到底边下方 12px
     * （覆盖条面顶边到 tooltip 底边的 8px 悬空缝）。只在 tipFor 存在时被调用。 */
    function inTipCorridor(x, y) {
      var r = tip.getBoundingClientRect();
      return x >= r.left - 4 && x <= r.right + 4 && y >= r.top && y <= r.bottom + 12;
    }
    /* 越顶宽限判定（v46）：tip 正上方 ±30px、高 80px 的柱形区——快速上移的采样点
     * 落进这里说明鼠标刚越过 tip 顶边，大概率下一拍就停在 tip 里。 */
    function inTipColumn(x, y) {
      var r = tip.getBoundingClientRect();
      return x >= r.left - 30 && x <= r.right + 30 && y >= r.top - 80 && y < r.top;
    }
    function cancelTipGrace() {
      if (tipGraceTimer) { clearTimeout(tipGraceTimer); tipGraceTimer = 0; }
    }

    /* ---------- 设置面板 ---------- */
    /* v172 待办指纹 → v208 仅待重启：marker mtime 代际（旧主进程缺 markerAt 时退 "?"）。
       红点只承载「需重启 ZCode」：更新成功且可热重载、发现新版本未安装等场景一律不亮；
       红点显示 = 指纹非空 且 ≠ 已查看指纹；点进「插件更新」分区即写 LS.updSeen 记为已查看 */
    function updFingerprint(u) {
      if (!u || !u.restartRequired) return "";
      return String(u.markerAt || "?");
    }
    function syncUpdateDots(on) {
      /* gear 在 buildPanel 首调（issue #55 时序）后才赋值：首轮 syncUpdate 可能读不到，防御 undefined */
      var gearDot = gear && gear.querySelector(".zu-gear-dot");
      if (gearDot) gearDot.style.display = on ? "block" : "none";
      var navDot = panel.querySelector('.zu-navitem[data-sec="update"] .zu-nav-dot');
      if (navDot) navDot.style.display = on ? "block" : "none";
    }
    /* v177：分量级比较——只要求 seen 覆盖当前全部分量：分量退出不复亮，出现新分量才复亮。
     * v208 起指纹仅待重启单分量，本比较仍保留以兼容旧版写入的「代际|版本」已查看串。 */
    function updSeenCovers(seen, fp) {
      if (!fp) return true;
      if (!seen) return false;
      if (seen === fp) return true;
      var parts = fp.split("|");
      for (var i = 0; i < parts.length; i++) {
        if (("|" + seen + "|").indexOf("|" + parts[i] + "|") < 0) return false;
      }
      return true;
    }
    function ackUpdateDots() {
      var fp = updFingerprint(state.pluginUpdate);
      if (!fp) return;
      var covered = false;
      try {
        covered = updSeenCovers(localStorage.getItem(LS.updSeen) || "", fp);
        if (!covered) localStorage.setItem(LS.updSeen, fp);   // 幂等：已覆盖不写（也避免触发多余 storage 事件）
      } catch (e) { }
      /* v177：已覆盖也要收敛本窗口红点——相同状态推送被 JSON 等值短路，漏收 storage 事件的
       * 窗口只能靠这次自愈；早退只跳过跨实例广播 */
      syncUpdateDots(false);
      if (covered) return;
      try { instances.forEach(function (inst) { inst.syncUpdate(); }); } catch (e) { }   // v172 同窗其余实例（多分栏）立刻收敛
    }
    /* v208 红点亮判定单一出口：syncUpdate 与齿轮跳转共用（restartNotice 关闭时不亮） */
    function updDotOn() {
      if (state.restartNotice === false) return false;
      var fp = updFingerprint(state.pluginUpdate);
      if (!fp) return false;
      var seen = "";
      try { seen = localStorage.getItem(LS.updSeen) || ""; } catch (eDotSeen) { }
      return !updSeenCovers(seen, fp);
    }
    /* v208 分区切换单一出口：导航点击与齿轮待重启跳转共用；切入「插件更新」即 ack（点进分区红点消失） */
    function activateSettingsSec(sec) {
      state.settingsSec = sec || "display";
      persist();
      if (state.settingsSec === "update") ackUpdateDots();
      try { syncNotes(); } catch (eSecNotes) { }   // v202：进入更新分区按需加载日志（失败静默，syncUpdate 下一轮兜底）
      var cur = activeSettingsSec();
      panel.querySelectorAll(".zu-settings-section[data-sec]").forEach(function (s) {
        s.hidden = s.getAttribute("data-sec") !== cur;
      });
      panel.querySelectorAll(".zu-navitem").forEach(function (b) {
        if (b.getAttribute("data-sec") === cur) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
      });
      var navBody = panel.querySelector(".zu-settings-body");
      if (navBody) navBody.scrollTop = 0;
      syncSettingsScroll();
    }
    function syncUpdate() {
      var u = state.pluginUpdate;
      var active = !!(u && u.supported);
      var version = panel.querySelector(".zu-settings-version");
      version.textContent = active && u.currentVersion ? u.currentVersion : "";
      version.hidden = !version.textContent;
      var cb = panel.querySelector(".zu-auto-update");
      cb.checked = !!(u && u.auto);
      cb.disabled = !active;
      /* 重启提醒开关真值不依赖更新器可用性（主进程无条件推送 restartNotice，缺省开；change 时代乐观更新） */
      var rn = panel.querySelector(".zu-restart-notice");
      if (rn) rn.checked = state.restartNotice !== false;
      panel.querySelector('[data-update=check]').disabled = !active || !!u.busy;
      panel.querySelector('[data-update=update]').disabled = !active || !!u.busy || u.phase !== "available";
      var relaunchBtn = panel.querySelector('[data-update=relaunch]');
      var relaunchDead = !!(u && u.relaunchSupported !== true);   // v180 issue #158：主进程缺能力标记（旧版）→ relaunch 指令必然无人接收
      var relaunchSent = !!(relaunchBtn && relaunchBtn.dataset && relaunchBtn.dataset.sent === "1");   // v244：重启请求已发出，状态推送重建状态行时保持「正在重启」态
      if (relaunchBtn) {
        relaunchBtn.hidden = relaunchDead;   // 降级为下方提示文案：浮层热更/主进程冷加载错位窗口里按钮「点了没反应」
        relaunchBtn.disabled = relaunchSent || !!(u && u.busy) || relaunchDead;   // 重启不依赖更新器：仅更新进行中禁用（u 为 null 时仍可点）
        relaunchBtn.classList.toggle("zu-rr-armed", !!(u && u.restartRequired));
      }
      /* v172 待办红点 → v208 仅待重启：需重启且未查看时亮 ⚙ 与「插件更新」导航点；其他窗口经各自 syncUpdate 收敛 */
      syncUpdateDots(updDotOn());
      var messages = {
        idle: L("尚未检测", "Not checked yet"),
        checking: L("正在检查更新…", "Checking for updates…"),
        available: L("发现新版本", "Update available"),
        current: L("当前已是最新版本", "Up to date"),
        downloading: L("正在下载更新…", "Downloading update…"),
        updating: L("正在安装更新…", "Installing update…"),
        updated: L("插件已更新；请重开会话以加载新版插件组件", "Plugin updated; start a new session to load the new components"),
        error: L("更新失败：", "Update failed: ") + (u && u.error || ""),
      };
      var text = !active ? L("仅支持已安装的 zusage-marketplace 用户插件；更新通道未就绪时需先升级插件并重启 ZCode。", "Requires the installed user plugin from zusage-marketplace. Upgrade the plugin and restart ZCode if the update channel is not ready.") : messages[u.phase] || messages.idle;
      if (!active && u && u.error) text += "\n" + messages.error;
      if (active && u.currentVersion) text += "\n" + L("当前版本：", "Current version: ") + u.currentVersion;
      if (active && u.latestVersion) text += (u.channel === "release" ? L(" · Release 版本：", " · Release version: ") : L(" · 市场版本：", " · Marketplace version: ")) + u.latestVersion;
      if (active && u.channel) text += "\n" + L("更新来源：", "Update source: ") + (u.channel === "release" ? (u.channelHost === "gitcode" ? L("GitCode 正式 Release（校验 ZIP 与 SHA256）", "stable GitCode Release (validated ZIP and SHA256)") : L("GitHub 正式 Release（校验 ZIP 与 SHA256）", "stable GitHub Release (validated ZIP and SHA256)"))
        : u.channel === "market" ? (u.channelHost === "gitcode" ? L("GitCode 仓库源码（由插件管理器直接更新）", "GitCode repository source (updated directly by the plugin manager)") : L("GitHub 仓库源码（由插件管理器直接更新）", "GitHub repository source (updated directly by the plugin manager)"))
        : L("本地目录市场", "local directory marketplace"));
      if (active && u.releaseUrl) text += "\n" + u.releaseUrl;
      if (active && u.checkedAt) text += "\n" + L("上次成功检查：", "Last successful check: ") + new Date(u.checkedAt).toLocaleString(state.lang === "en" ? "en-US" : "zh-CN");
      if (u && (u.phase === "updating" || u.phase === "downloading")) text += "\n" + L("关闭自动更新仅阻止后续安装；已开始的安装会继续完成", "Turning automatic updates off stops future installs; an install already started will finish");
      /* v208 已更新待重启提示条：替代原状态行追加文案；旧主进程（relaunchDead）无重启按钮，
       * 提示条不显示，保留原文字指引与下方 relaunchDead 降级提示 */
      var updBanner = panel.querySelector(".zu-upd-banner");
      if (updBanner) {
        var bannerOn = !!(u && u.restartRequired && !relaunchDead);
        updBanner.hidden = !bannerOn;
        if (bannerOn) updBanner.textContent = L("已更新成功，点击重启 ZCode 即可生效", "Update installed — click Restart ZCode to apply");
      }
      if (u && u.restartRequired && relaunchDead) text += "\n" + L("主进程或关闭热更新的文件已更新，需重启 ZCode", "Restart ZCode to load main-process updates or files with hot reload disabled");
      if (relaunchDead) text += "\n" + L("「重启 ZCode」需要新版主进程支持：当前主进程是旧版本，请完全退出 ZCode 后重新打开。", "Restarting ZCode needs a newer main process: the running main process is outdated — quit ZCode completely and reopen it.");
      if (u && u.skipped && u.skipped.length) text += "\n" + L("保留本地热修（未覆盖）：", "Local edits preserved (not overwritten): ") + u.skipped.join(", ");
      /* v140 API 限流兜底也失败时引导显式切 GitCode 渠道（错误签名在 plugin-updater catalogFallback） */
      if (u && u.phase === "error" && /渠道清单回退/.test(u.error || "")) text += "\n" + L("GitHub API 不可达且清单回退失败；可改用国内 GitCode 镜像渠道：安装或更新 zcode 插件 https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode", "GitHub API is unreachable and the catalog fallback failed; switch to the GitCode mirror: install or update the zcode plugin https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode");
      if (relaunchSent) text += "\n" + L("已发出重启请求：ZCode 正在退出全部窗口并自动重新打开；等待会话与扩展子进程退出通常需要几秒到几十秒，请稍候。", "Restart request sent: ZCode is closing all windows and will reopen automatically; waiting for session and extension child processes to exit can take a few seconds to tens of seconds.");
      panel.querySelector(".zu-update-status").textContent = text;
      syncProgress(active ? u : null);
      /* 逐问速率行开关勾选态：state.rateLine 由主进程推送（或 change 时代乐观更新） */
      var rl = panel.querySelector(".zu-rate-line");
      if (rl) rl.checked = state.rateLine;
      var qe = panel.querySelector(".zu-quota-enable");   // v95：勾选态由主进程推送的 quotaEnabled 决定
      if (qe) qe.checked = state.quotaEnabled;
      var re = panel.querySelector(".zu-rst-enable");   // v135：勾选态由主进程推送的 resetBadgeEnabled 决定
      if (re) re.checked = state.resetBadge;
      var ac = panel.querySelector(".zu-ac-enable");   // v179：勾选态由主进程推送的 enginePatch.enabled 决定
      if (ac) ac.checked = !!(state.enginePatch && state.enginePatch.enabled);
      try { syncAutoCompactInputs(); } catch (eAc) { try { window.__zusageDiag.acPanelErr = String((eAc && eAc.stack) || eAc); } catch (_) { } }   // 防御：阈值面板渲染失败不得拖垮 syncPanel（同 syncQuotaSources 先例）
      try { syncQuotaSources(); } catch (eSrc) { try { window.__zusageDiag.quotaSrcErr = String((eSrc && eSrc.stack) || eSrc); } catch (_) { } }   // 防御：多源列表渲染失败不得拖垮实例创建（实测 SRC_FIELD_LABELS 时序可致整条状态条消失）
      try { syncNotes(); } catch (eNotes) { try { window.__zusageDiag.notesErr = String((eNotes && eNotes.stack) || eNotes); } catch (_) { } }   // 防御：更新日志渲染失败不得拖垮整个 ⚙ 面板（同 syncQuotaSources 先例）
    }
    /* ---------- v202 更新日志卡片（数据链：pluginRequest("release-notes"/"-list") → 主进程
     * 按注册 Release 渠道代拉 GitHub/GitCode 发布说明并缓存；渲染进程只传 version/force） ---------- */
    /* 状态变量必须在早期 buildPanel()（issue #55 时序）之前赋值：var 只提升声明不提升初始值，
     * 曾实测 buildPanel→syncUpdate→syncNotes 在赋值前执行把 notesSel 读成 undefined。 */
    /* 渠道：Release 渠道取本渠道 Release（verified）；market（源码）渠道取注册仓库的
     * 同号 Release 作参考正文（verified:false，浮层标注未核实）；本地目录无仓库身份，离线。 */
    function notesChannelOf(u) {
      if (!u || !u.channel || u.channel === "local") return null;
      return { flavor: u.channelHost === "gitcode" ? "gitcode" : "github", verified: u.channel === "release" };
    }
    /* 默认日志选择（唯一依据是主进程推送的可靠状态，不猜）：
     * 待重启=已装完成（markerVersion 实际写入运行目录的版本，退 pendingRelease 目标）→
     * 下载/安装中=安装目标 → 失败=保留失败目标并标注未安装 → 有新版=可用目标 → 已是最新=当前版本。 */
    function notesDefaultTarget(u) {
      if (!u || !u.supported) return null;
      if (u.restartRequired) {
        var pending = u.pendingRelease && u.pendingRelease.release;
        var v = typeof u.markerVersion === "string" && u.markerVersion ? u.markerVersion
          : pending && typeof pending.version === "string" && pending.version ? pending.version : "";
        if (v) return { version: v, status: "installed-restart" };
        if (u.phase === "updated" && u.latestVersion) return { version: u.latestVersion, status: "installed-restart" };
        return { unknown: true, status: "installed-restart" };   // 待重启但版本身份无法确定：明示，不拿其他版本冒充
      }
      if (u.phase === "downloading" || u.phase === "updating") {
        var pr = u.pendingRelease && u.pendingRelease.release;
        var v2 = pr && typeof pr.version === "string" && pr.version ? pr.version : u.latestVersion;
        return v2 ? { version: v2, status: "installing" } : null;
      }
      if (u.phase === "error" && u.lastFailure && typeof u.lastFailure.version === "string" && u.lastFailure.version) {
        return { version: u.lastFailure.version, status: "failed" };
      }
      if (u.phase === "updated" && u.latestVersion) return { version: u.latestVersion, status: "current" };   // 热文件已重载，无待重启
      if (u.phase === "available" && u.latestVersion) return { version: u.latestVersion, status: "available" };
      if (u.phase === "current" && u.currentVersion) return { version: u.currentVersion, status: "current" };
      /* 未触发检查更新（idle/检查失败等）：当前已装版本就是可靠身份，直接展示它的日志；
       * 该版本无 Release 时如实提示，可转历史版本。渠道未知也发起拉取——主进程按注册
       * 渠道门控，market/local 会被拒绝且不产生任何网络请求。 */
      if (u.currentVersion) return { version: u.currentVersion, status: "current" };
      return null;
    }
    function notesPickTarget(u) {
      var def = notesDefaultTarget(u);
      if (notesSel.explicit && notesSel.version) {
        if (def && def.version === notesSel.version) return { def: def, target: def };   // 选择已被默认追上：按真实状态显示，粘性自然失效
        return { def: def, target: { version: notesSel.version, status: "history" } };
      }
      return { def: def, target: def };
    }
    function notesStatusBadge(status) {
      return {
        "installed-restart": L("已安装，待重启", "Installed, restart pending"),
        "installing": L("安装中", "Installing"),
        "failed": L("更新失败，未安装成功", "Update failed, not installed"),
        "available": L("可用版本", "Available version"),
        "current": L("当前版本", "Current version"),
        "history": L("历史版本", "History"),
      }[status] || "";
    }
    /* Release 页链接：版本为稳定语义版时指向具体 tag，否则回退 releases 列表页（market 参考入口） */
    function notesReleasePageUrl(flavor, repository, version) {
      var base = flavor === "gitcode" ? "https://gitcode.com/" : "https://github.com/";
      if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository) || repository.length > 200) return "";
      return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)
        ? base + repository + "/releases/tag/v" + version
        : base + repository + "/releases";
    }
    /* GitCode 的 tag 深链页对本项目（API 创建的）Release 一律「找不到或无权限」——平台路由
     * bug，2026-11-04 匿名实测；/releases 列表页正常。发布页链接对 GitCode 一律落到列表页，
     * GitHub 保持精确 tag 深链。 */
    function notesReachablePageUrl(url) {
      return typeof url === "string" && /^https:\/\/gitcode\.com\/[^/\s]+\/[^/\s]+\/releases\/tag\//.test(url)
        ? url.replace(/\/releases\/tag\/[^/?#]*$/, "/releases") : url;
    }
    /* 渠道未知（未检查过）时从已验证回复的发布页 URL 推导来源标签 */
    function notesHostLabel(notes) {
      var url = notes && notes.url;
      return /^https:\/\/github\.com\//.test(String(url || "")) ? "GitHub"
        : /^https:\/\/gitcode\.com\//.test(String(url || "")) ? "GitCode" : "";
    }
    function notesFmtDate(iso) {
      var t = Date.parse(String(iso || ""));
      return isFinite(t) ? new Date(t).toLocaleDateString(state.lang === "en" ? "en-US" : "zh-CN") : "";
    }
    /* ---------- 受限 Markdown：转义优先的行级子集（发布说明够用）----------
     * 只支持 标题/列表/引用/分隔线/围栏代码/行内代码/粗斜体/链接/裸 URL；HTML 一律按文本
     * 显示，图片默认禁用（只留 alt 文本不发请求），链接仅 https 且带上限，点击走 openExternal。 */
    function notesSafeLinkUrl(u) {
      return typeof u === "string" && u.length <= 600 && /^https:\/\/\S+$/.test(u) ? u : "";   // 与点击侧同款大小写敏感：HTTPS:// 渲染为文本，不产出死链按钮
    }
    function notesInline(text) {
      var out = "", last = 0, m;
      var re = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]{1,600})\)|\[([^\]]{0,200})\]\(([^)\s]{1,600})\)|\*\*([^*\n]{1,300}?)\*\*|\*([^*\s][^*\n]{0,300}?)\*|(https:\/\/[^\s<>()\[\]{}"“”‘’]{4,400})/g;
      while ((m = re.exec(text))) {
        out += mEsc(text.slice(last, m.index));
        if (m[1] !== undefined) out += "<code>" + mEsc(m[2]) + "</code>";
        else if (m[3] !== undefined) out += mEsc(m[3] || L("图片", "image"));   // 图片禁用：仅 alt 文本
        else if (m[5] !== undefined) {
          var href = notesSafeLinkUrl(m[6]);
          out += href ? '<button type="button" class="zu-notes-lnk" data-href="' + mEsc(href) + '">' + (mEsc(m[5]) || mEsc(href)) + "</button>"
            : mEsc(m[5]) + "（" + mEsc(m[6]) + "）";
        } else if (m[7] !== undefined) out += "<strong>" + notesInline(m[7]) + "</strong>";
        else if (m[8] !== undefined) out += "<em>" + notesInline(m[8]) + "</em>";
        else {
          var bare = notesSafeLinkUrl(m[9]);
          out += bare ? '<button type="button" class="zu-notes-lnk" data-href="' + mEsc(bare) + '">' + mEsc(bare) + "</button>" : mEsc(m[9]);
        }
        last = re.lastIndex;
      }
      return out + mEsc(text.slice(last));
    }
    function notesBlocks(md) {
      var lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
      var blocks = [], para = null, list = null, quote = null, code = null, codeText = null;
      function closePara() { if (para) { blocks.push({ type: "p", text: para.join("\n") }); para = null; } }
      function closeList() { if (list) { blocks.push(list); list = null; } }
      function closeQuote() { if (quote) { blocks.push({ type: "quote", text: quote.join("\n") }); quote = null; } }
      function closeAll() { closePara(); closeList(); closeQuote(); }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (code !== null) {
          if (/^\s*(```|~~~)\s*$/.test(line)) { blocks.push({ type: "pre", text: codeText || "" }); code = null; }
          else codeText = codeText === null ? line : codeText + "\n" + line;
          continue;
        }
        if (/^\s*(```|~~~)/.test(line)) { closeAll(); code = "```"; codeText = null; continue; }
        if (/^\s*$/.test(line)) { closeAll(); continue; }
        var heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading) { closeAll(); blocks.push({ type: "h", level: Math.min(3, heading[1].length), text: heading[2] }); continue; }
        if (/^\s{0,3}(?:-\s*){3,}$/.test(line) || /^\s{0,3}(?:\*\s*){3,}$/.test(line) || /^\s{0,3}(?:_\s*){3,}$/.test(line)) { closeAll(); blocks.push({ type: "hr" }); continue; }
        var item = /^\s{0,6}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
        if (item) {
          closePara(); closeQuote();
          var ordered = /^\s{0,6}\d/.test(line);
          if (list && list.ordered !== ordered) closeList();
          if (!list) list = { type: "list", ordered: ordered, items: [] };
          list.items.push(item[1]);
          continue;
        }
        var q = /^\s{0,3}>\s?(.*)$/.exec(line);
        if (q) { closePara(); closeList(); (quote = quote || []).push(q[1]); continue; }
        closeList(); closeQuote();
        (para = para || []).push(line);   // 段内软换行按作者换行保留
      }
      if (code !== null) blocks.push({ type: "pre", text: codeText || "" });
      closeAll();
      return blocks;
    }
    function notesBlockHtml(b) {
      if (b.type === "h") return '<div class="zu-notes-h zu-notes-h' + b.level + '">' + notesInline(b.text) + "</div>";
      if (b.type === "list") {
        var out = b.ordered ? "<ol>" : "<ul>";
        for (var i = 0; i < b.items.length; i++) out += "<li>" + notesInline(b.items[i]) + "</li>";
        return out + (b.ordered ? "</ol>" : "</ul>");
      }
      if (b.type === "quote") return "<blockquote>" + notesInline(b.text).replace(/\n/g, "<br>") + "</blockquote>";
      if (b.type === "pre") return "<pre><code>" + mEsc(b.text) + "</code></pre>";
      if (b.type === "hr") return "<hr>";
      return "<p>" + notesInline(b.text).replace(/\n/g, "<br>") + "</p>";
    }
    /* 按标题分节：只用于折叠预览与「升级注意」置顶；正文渲染永远完整，不靠标题截内容 */
    function notesSectionsOf(blocks) {
      var sections = [], cur = null;
      for (var i = 0; i < blocks.length; i++) {
        if (!cur || blocks[i].type === "h") {
          if (cur) sections.push(cur);
          cur = { title: blocks[i].type === "h" ? blocks[i].text : "", blocks: [] };
        }
        cur.blocks.push(blocks[i]);
      }
      if (cur) sections.push(cur);
      return sections;
    }
    function notesIsAttn(title) {
      return /升级|注意|兼容|Breaking|Upgrade|Attention|Important|⚠/i.test(String(title || ""));
    }
    function notesSectionHtml(sec) {
      var out = "";
      for (var i = 0; i < sec.blocks.length; i++) out += notesBlockHtml(sec.blocks[i]);
      return out;
    }
    function notesSectionLen(sec) {
      var n = String(sec.title || "").length;
      for (var i = 0; i < sec.blocks.length; i++) {
        var b = sec.blocks[i];
        n += String(b.text || "").length + (b.items ? b.items.join("").length : 0);
      }
      return n;
    }
    /* 折叠预览：整节切分（不截半节），预览取前面的节到约 600 字符为止；「升级注意」类
     * 标题的节无论位置都完整可见并高亮。折叠态明确提示还有更多内容，不静默丢弃。 */
    /* 渲染入口：正文先钳长（缓存层也会截，这里兜底直传路径），4 连以上反引号归一为
     * 三连——行内代码正则对长反引号串是多项式回溯（实测 8KB 数百 ms、64KB 分钟级），
     * 外部正文不可信，必须在进正则前拆掉引爆串。 */
    var NOTES_MAX_RENDER_CHARS = 64 * 1024;
    function notesHtml(md, expanded) {
      md = String(md || "").slice(0, NOTES_MAX_RENDER_CHARS).replace(/`{4,}/g, "```");
      var sections = notesSectionsOf(notesBlocks(md));
      var attn = [], normal = [];
      for (var i = 0; i < sections.length; i++) (notesIsAttn(sections[i].title) ? attn : normal).push(sections[i]);
      if (expanded) {
        var full = "";
        for (i = 0; i < normal.length; i++) full += notesSectionHtml(normal[i]);
        for (i = 0; i < attn.length; i++) full += '<div class="zu-notes-attn">' + notesSectionHtml(attn[i]) + "</div>";
        return { html: full, more: false };
      }
      var html = "", count = 0, shown = 0;
      for (i = 0; i < normal.length; i++) {
        if (count >= 600 && shown > 0) break;
        html += notesSectionHtml(normal[i]); count += notesSectionLen(normal[i]); shown++;
      }
      for (i = 0; i < attn.length; i++) html += '<div class="zu-notes-attn">' + notesSectionHtml(attn[i]) + "</div>";
      return { html: html, more: shown < normal.length };
    }
    function requestNotes(version, force) {
      if (!version) return;
      var seq = ++notesReqSeq;
      notesLoadedVersion = version; notesResult = null; notesError = { reason: "loading" };
      notesAutoTriedVersion = version;   // 手动/切换请求自己负责加载：防止 syncNotes 自动分支对同版本再触发（重复拉取反馈环）
      notesRequestedAt = Date.now();
      syncNotes();
      pluginRequest("release-notes", { version: version, force: force === true }, function (result) {
        if (inactive() || seq !== notesReqSeq) return;   // 乱序/实例销毁守卫：旧结果不覆盖新选择
        notesResult = result && result.ok ? result : null;
        notesError = result && !result.ok ? result : null;
        syncNotes();
      });
    }
    function requestNotesList(force) {
      var seq = ++notesListSeq;
      notesHistoryState = "loading";
      renderNotesHistory();
      pluginRequest("release-notes-list", { force: force === true }, function (result) {
        if (inactive() || seq !== notesListSeq) return;
        notesHistory = result && result.ok && Array.isArray(result.releases) ? result : null;
        notesHistoryError = result && !result.ok ? result : null;
        notesHistoryState = "done";
        renderNotesHistory();
      });
    }
    function renderNotesHistory() {
      var histPanel = panel.querySelector(".zu-notes-history");
      if (!histPanel || histPanel.hidden) return;
      var rows = notesHistory && notesHistory.releases;
      var cur = notesPickTarget(state.pluginUpdate).target;
      var sig = notesHistoryState + "|" + (rows ? rows.map(function (r) { return r.tag; }).join(",") : "") +
        "|" + (notesHistoryError ? String(notesHistoryError.reason || notesHistoryError.error || "err") : "") +
        "|" + (cur && cur.version ? cur.version : "");   // 选中版本变化也要重绘（aria-current 即时迁移）
      if (sig === notesHistorySig) return;
      notesHistorySig = sig;
      var html = "";
      if (notesHistoryState === "loading") html = '<div class="zu-notes-hist-note">' + L("正在加载历史版本…", "Loading version history…") + "</div>";
      else if (!rows) {
        var reason = notesHistoryError ? String(notesHistoryError.reason || "") : "";
        var errText = notesHistoryError ? String(notesHistoryError.error || notesHistoryError.message || "") : "";
        html = '<div class="zu-notes-hist-note">' + (/^unknown action:/.test(errText) ? L("当前主进程为旧版本，暂不支持在线历史版本。", "The main process is outdated; online history is unavailable.")
          : reason === "rate-limited" ? L("暂时无法获取历史版本（API 限流），可稍后重试。", "Version history is temporarily unavailable (rate limited); try again later.")
          : reason === "unsupported-channel" || reason === "unsupported" ? L("当前来源暂不支持在线日志。", "Online release notes are not available for this source.")
          : reason ? L("暂时无法获取历史版本，可重试。", "Version history is temporarily unavailable; retry.")
          : L("暂无历史版本记录。", "No version history yet.")) + "</div>";
        if (reason && reason !== "unsupported-channel" && reason !== "unsupported" && !/^unknown action:/.test(errText)) {
          html += '<button type="button" class="zu-notes-hist-retry">' + L("重试", "Retry") + "</button>";   // 失败态给重试入口（force 绕过缓存）
        }
      } else {
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          html += '<button type="button" class="zu-notes-hist-item" data-version="' + mEsc(r.version) + '"' +
            (cur && cur.version === r.version ? ' aria-current="true"' : "") + '><span class="zu-notes-hist-ver">' + mEsc(r.tag) +
            '</span><span class="zu-notes-hist-name">' + mEsc(r.name !== r.tag ? r.name : notesFmtDate(r.publishedAt)) + "</span></button>";
        }
        html += '<div class="zu-notes-hist-note">' + L("仅列出正式发布的版本；更早的历史版本可能未收录。", "Stable releases only; older versions may be missing.") + "</div>";
      }
      histPanel.innerHTML = html;
    }
    function syncNotes() {
      var u = state.pluginUpdate;
      var badge = panel.querySelector(".zu-notes-badge");
      var meta = panel.querySelector(".zu-notes-meta");
      var body = panel.querySelector(".zu-notes-body");
      var histBtn = panel.querySelector(".zu-notes-history-btn");
      var backBtn = panel.querySelector(".zu-notes-back");
      var toggle = panel.querySelector(".zu-notes-toggle");
      var link = panel.querySelector(".zu-notes-link");
      var retry = panel.querySelector(".zu-notes-retry");
      var histPanel = panel.querySelector(".zu-notes-history");
      if (!badge || !meta || !body || !histBtn || !backBtn || !toggle || !link || !retry || !histPanel) return;
      var ch = notesChannelOf(u);
      var pick = notesPickTarget(u);
      var def = pick.def, target = pick.target;
      /* 空状态：渠道明确为 market/local 时不联网（market 有注册仓库时给明确标注的参考链接）；
       * 版本身份缺失时明示，不冒充。渠道未知但有当前版本时不再空转——走下方正常流程，
       * 由主进程渠道门控裁决（本地/源码渠道会被拒绝且零网络开销）。 */
      var emptyKey = "";
      if (!target) emptyKey = !u || !u.supported ? "inactive" : "nomatch";
      else if (target.unknown) emptyKey = "unknown";   // 待重启但版本身份无法确定：明示，不冒充
      else if (!ch && u && u.channel === "local") emptyKey = "local";   // 本地目录：无仓库身份，不联网
      if (emptyKey) {
        notesBodySig = ""; body.innerHTML = ""; body.setAttribute("aria-busy", "false");
        badge.textContent = ""; badge.style.display = "none";
        meta.textContent = emptyKey === "local" ? L("本地目录来源不联网，暂无更新日志。", "Directory sources stay offline; no release notes.")
          : emptyKey === "unknown" ? L("已安装待重启，但无法确定本次安装的版本，暂不显示更新日志。", "Waiting for restart, but the installed version can't be determined; notes are hidden.")
          : L("尚未检查或没有可靠的版本身份；检查更新后这里会显示对应版本的日志。", "No reliable version identity yet; run a check to see matching notes.");
        histBtn.hidden = true; histPanel.hidden = true;
        backBtn.hidden = true;
        toggle.hidden = true; retry.hidden = true;
        link.hidden = true; link.removeAttribute("data-href");
        return;
      }
      /* Release 渠道：按 target 拉取并渲染 */
      var visible = panel.classList.contains("open") && activeSettingsSec() === "update";
      if (visible && notesAutoTriedVersion !== target.version) {
        notesAutoTriedVersion = target.version;   // 每个目标只自动拉一次；失败后靠手动重试，不做高频轮询
        requestNotes(target.version, false);
        return;
      }
      if (notesError && notesError.reason === "loading" && Date.now() - notesRequestedAt > NOTES_LOADING_TIMEOUT_MS) {
        notesError = { reason: "network", message: "timeout" };   // 回执丢失兜底：不再永挂「正在加载」，转可重试
      }
      var loading = notesError && notesError.reason === "loading" && notesLoadedVersion === target.version;
      var status = target.status === "history" ? "history" : def && def.version === target.version ? def.status : "history";
      badge.style.display = "";
      badge.textContent = notesStatusBadge(status) + " · v" + target.version;
      badge.classList.toggle("zu-notes-warn", status === "failed");
      /* 未核实标注：market（源码）渠道展示的是注册仓库的同号 Release，不冒充本渠道已核实内容 */
      var unverified = (ch ? ch.verified === false : notesLoadedVersion === target.version &&
        !!(notesResult && notesResult.verified === false));
      var srcLabel = ch ? (ch.flavor === "gitcode" ? "GitCode" : "GitHub")
        : notesHostLabel(notesLoadedVersion === target.version ? notesResult : null);
      if (notesLoadedVersion === target.version && notesResult && notesResult.mirror) {
        srcLabel = L("GitCode 镜像（GitHub 限流回退）", "GitCode mirror (GitHub rate-limit fallback)");   // 镜像回退如实标注实际来源
      }
      var metaText = notesLoadedVersion === target.version && notesResult && notesResult.cachedAt
        ? (srcLabel ? L("来源：", "Source: ") + srcLabel : "") +
          (notesResult.stale ? L(" · 正在显示缓存，最近获取：", " · showing cache, fetched: ") : L(" · 缓存于：", " · cached: ")) + (isFinite(notesResult.cachedAt) ? notesFmtDate(new Date(Math.min(notesResult.cachedAt, 8.64e15)).toISOString()) : "")
        : loading ? L("正在加载更新日志…", "Loading release notes…")
        : srcLabel ? L("来源：", "Source: ") + srcLabel + (ch && ch.flavor === "gitcode" && u.channelRepo ? " · " + u.channelRepo : "") : "";
      if (unverified && notesLoadedVersion === target.version && notesResult) {
        metaText += (metaText ? " " : "") + L("· 参考：同号 Release，未核实与本渠道一致", "· reference: same-version release, parity with this source unverified");
      }
      meta.textContent = metaText;
      var notesProved = notesLoadedVersion === target.version &&
        ((notesResult && typeof notesResult.url === "string") || (notesError && notesError.reason === "missing"));
      histBtn.hidden = !(ch || notesProved);   // 渠道已知或已被回复证实为 Release 渠道才提供历史版本
      /* 粘性选择的返回入口：默认目标存在且与当前不同时可见；安装状态变化时由此轻量收敛 */
      var backVisible = !!(notesSel.explicit && def && def.version && def.version !== target.version);
      backBtn.hidden = !backVisible;
      if (backVisible) backBtn.textContent = L("返回默认版本 v", "Back to v") + def.version;
      if (histPanel.hidden) notesHistorySig = "";   // 收起后下次展开强制重绘（状态可能已变）；开合只由用户点击驱动
      var pageUrl = ch ? notesReleasePageUrl(ch.flavor, u.channelRepo, target.version) : "";
      if (notesLoadedVersion === target.version && notesResult && notesResult.mirror && typeof notesResult.url === "string" &&
          notesResult.url.length <= 600 && /^https:\/\/(github|gitcode)\.com\//.test(notesResult.url)) {
        pageUrl = notesResult.url;   // 镜像回退：链接指向内容实际来源的发布页
      }
      if (!pageUrl && notesProved && notesResult && typeof notesResult.url === "string" &&
          notesResult.url.length <= 600 && /^https:\/\/(github|gitcode)\.com\//.test(notesResult.url)) pageUrl = notesResult.url;
      pageUrl = notesReachablePageUrl(pageUrl);   // 主路径与镜像/未核实回退统一：GitCode tag 深链是平台 bug 页，落到可达的列表页
      if (pageUrl) {
        link.hidden = false; link.setAttribute("data-href", pageUrl);
        link.textContent = unverified ? L("参考：发布页（未核实与本渠道一致）", "Reference: releases page (parity unverified)") : L("完整发布说明", "Full release notes");
      }
      else { link.hidden = true; link.removeAttribute("data-href"); }
      retry.hidden = !(notesError && notesLoadedVersion === target.version && ["rate-limited", "network", "error"].indexOf(notesError.reason) >= 0);
      /* 正文：签名幂等——内容没变不重建，保滚动位置与焦点 */
      var rendered = null, html = "", sig = "";
      if (loading) { html = '<p class="zu-notes-more">' + L("正在加载更新日志…", "Loading release notes…") + "</p>"; sig = "loading|" + target.version; }
      else if (notesResult && notesLoadedVersion === target.version && typeof notesResult.body === "string") {
        rendered = notesHtml(notesResult.body, notesExpanded);
        html = rendered.html;
        if (rendered.more) html += '<p class="zu-notes-more">' + L("还有更多内容，点下方「展开全部」。", "More content below — use \"Expand\" to show it all.") + "</p>";
        sig = "ok|" + target.version + "|" + notesExpanded + "|" + html.length;
      } else if (notesError && notesLoadedVersion === target.version) {
        var reason = String(notesError.reason || "");
        html = '<p class="zu-notes-more">' + (reason === "missing" ? L("此版本暂无更新日志（可能尚未发布 Release）。", "No release notes for this version (release may not exist yet).")
          : reason === "rate-limited" ? L("暂时无法获取（API 限流），可点「重试」。", "Temporarily unavailable (rate limited); use \"Retry\".")
          : reason === "unsupported-channel" || reason === "unsupported" ? L("当前来源暂不支持在线日志。", "Online release notes are not available for this source.")
          : /^unknown action:/.test(String(notesError.error || "")) ? L("当前主进程为旧版本，暂不支持在线日志。", "The main process is outdated; online notes are unavailable.")
          : reason === "loading" ? L("正在加载更新日志…", "Loading release notes…")
          : L("暂时无法获取，可点「重试」。", "Temporarily unavailable; use \"Retry\".")) + "</p>";
        sig = "err|" + target.version + "|" + reason;
      } else { html = '<p class="zu-notes-more">' + L("正在加载更新日志…", "Loading release notes…") + "</p>"; sig = "pending|" + target.version; }
      if (sig !== notesBodySig || (!body.innerHTML && html)) {   // 后者：buildPanel 重建骨架后闭包签名残留，强制回填正文
        notesBodySig = sig;
        body.innerHTML = html;
        body.setAttribute("aria-busy", loading ? "true" : "false");
      }
      toggle.hidden = !(notesResult && notesLoadedVersion === target.version);
      toggle.textContent = notesExpanded ? L("收起", "Collapse") : L("展开全部", "Expand all");
      if (notesHistoryState === "" && !histPanel.hidden) requestNotesList(false);
    }
    /* ---------- v179 自动压缩阈值（⚙ 面板渲染与提交的单一出口） ---------- */
    function acModeOf(cfg) {
      if (!cfg || typeof cfg !== "object") return { mode: "default", value: "" };
      if (cfg.enabled === false) return { mode: "disabled", value: "" };
      if (isFinite(cfg.thresholdPercent)) return { mode: "percent", value: String(cfg.thresholdPercent) };
      if (isFinite(cfg.thresholdTokens)) return { mode: "tokens", value: String(cfg.thresholdTokens) };
      if (isFinite(cfg.bufferTokens)) return { mode: "buffer", value: String(cfg.bufferTokens) };
      return { mode: "default", value: "" };
    }
    function syncAutoCompactInputs() {
      var input = panel.querySelector(".zu-ac-value");   // v188：模式并入数值——留空=跟随引擎默认
      var cur = acModeOf(state.enginePatch && state.enginePatch.config);
      if (input && document.activeElement !== input) input.value = cur.mode === "percent" ? cur.value : "";
      /* v190：注入开关关闭时数值行没有意义，整行隐藏 */
      var acRow = input && input.closest ? input.closest("label") : null;
      if (acRow) acRow.hidden = !!(state.enginePatch && state.enginePatch.enabled === false) || state.enginePatch == null;
      var node = panel.querySelector(".zu-ac-status");
      if (!node) return;
      var ep = state.enginePatch;
      var text = "";
      if (!ep) text = L("主进程补丁模块未加载；完全重启 ZCode 后可用。", "Engine patch module not loaded; fully restart ZCode first.");
      else if (!ep.enabled) text = L("开关关闭：引擎保持原生行为。", "Off: the engine keeps its built-in behavior.");
      else {
        var m = {
          applied: L("已注入", "Injected"),
          unsupported_build: L("当前客户端引擎版本不在支持名单，等待插件更新", "This engine build is not supported yet; wait for a plugin update"),
          engine_missing: L("未找到引擎文件", "Engine file not found"),
          busy: L("引擎文件被占用，重启 ZCode 后重试", "Engine file is busy; restart ZCode and retry"),
          error: L("注入失败", "Injection failed"),
        };
        /* v225（issue #191）：桌面 build 已登记而引擎 sha 脱钩 = 引擎文件被单独热更，
         * 与"全新桌面版本"分开明示；lastError 后缀此时与 sha 重复，不再拼接。 */
        var drift = ep.state === "unsupported_build" && ep.drifted;
        var sha12 = typeof ep.engineSha256 === "string" && ep.engineSha256.length >= 12 ? ep.engineSha256.slice(0, 12) : "";
        var base = drift
          ? L("客户端引擎文件已被单独热更" + (sha12 ? "（sha " + sha12 + "…）" : "") + "，自动压缩阈值暂不可用；等待插件适配，可将该 sha 前缀反馈给维护者加快登记",
              "The engine file was hot-updated separately" + (sha12 ? " (sha " + sha12 + "…)" : "") + "; the auto-compact threshold is unavailable until the plugin adapts — reporting this sha prefix to the maintainer speeds up registration")
          : (m[ep.state] || ep.state);
        text = base + (ep.build ? " · " + ep.build : "") +
          (ep.state === "applied" ? L("；已运行会话保持旧阈值，新会话生效", "; running sessions keep the old threshold, new sessions apply") : "") +
          (ep.lastError && ep.state !== "applied" && !drift ? " · " + ep.lastError : "");
      }
      var warn = acWarningText();
      /* v194：数值行实时校验——超出 30-99 或非数字在状态行提示，提交侧同步拒绝 */
      var acv = input && input.value != null ? String(input.value).trim() : "";
      var bad = acv !== "" && (!isFinite(Number(acv)) || Number(acv) < 30 || Number(acv) > 99);
      var msg = (bad ? L("⚠ 阈值数值需在 30-99 之间", "⚠ Threshold must be between 30 and 99") : "") +
        (warn ? (bad ? "\n" : "") + warn : "");
      node.textContent = text + (msg ? "\n" + msg : "");
      node.classList.toggle("zu-ac-warn", !!(warn || bad));
    }
    function acTargetTokens(mc, cw) {
      if (mc.mode === "default" || mc.mode === "disabled") return null;
      var RESERVE = 21000;   // 引擎输出预留上限（policy.ts PREFLIGHT 常量；实际 min(maxOut,21K)，此处近似）
      var th = mc.mode === "percent" ? Math.min(cw * (parseFloat(mc.value) / 100), cw - RESERVE)   // v194：总窗口口径（与引擎 hook 同式），极端值钳在有效窗口内
        : mc.mode === "tokens" ? parseFloat(mc.value)
          : (cw - RESERVE) - parseFloat(mc.value);
      return isFinite(th) ? th : null;
    }
    function acWarningText() {
      var ep = state.enginePatch;
      if (!ep || !ep.enabled || ep.state !== "applied") return "";
      var mc = acModeOf(ep.config);
      var cw = lastBand && lastBand.cw;
      var cur = lastBand && isFinite(lastBand.pct) ? lastBand.pct : null;
      if (!cw || cur == null) return "";
      var th = acTargetTokens(mc, cw);
      if (th == null) return "";
      return th / cw * 100 < cur ? L("⚠ 目标阈值低于当前用量，可能立即触发压缩", "⚠ Target threshold is below current usage; compaction may trigger immediately") : "";
    }
    function sendAutoCompactConfig() {
      var input = panel.querySelector(".zu-ac-value");
      if (!input) return;
      var value = input.value.trim();
      /* v194：30-99 之外的数值不提交（状态行实时提示），避免非法值写进 autocompact.json */
      var acn = Number(value);
      if (value !== "" && (!isFinite(acn) || acn < 30 || acn > 99)) { showSettingsFeedback(true); return; }
      showSettingsFeedback(false, true);
      /* v188：留空=跟随引擎默认（default），有值=百分比（percent） */
      pluginRequest("autocompact-config", { mode: value === "" ? "default" : "percent", value: value === "" ? undefined : Number(value) }, function (result) {
        if (inactive()) return;
        if (result.ok) {
          if (result.config) { if (!state.enginePatch) state.enginePatch = { enabled: false, state: "off" }; state.enginePatch.config = result.config; }
          showSettingsFeedback(false, false);
        } else showSettingsFeedback(true);
        syncAutoCompactInputs();   // 成败都回写主进程真值（失败回滚为主进程现值）
      });
    }
    function srcStatusText(sv) {
      if (sv.busy) return L("查询中…", "Querying…");
      var m = { ok: L("查询成功", "Query succeeded"), idle: L("待查询", "pending"), not_configured: L("未配置凭据", "credential missing"),
        disabled: L("已关闭", "off"),
        auth_failed: L("认证失效", "auth failed"), no_plan: L("无订阅", "no subscription"),
        rate_limited: L("限流中", "rate limited"), network_error: L("查询失败", "failed"),
        parse_error: L("响应异常", "bad response"), unsupported: L("不支持", "unsupported") };
      return m[sv.status] || sv.status || "";
    }
    function showSettingsFeedback(error, pending) {
      var node = panel.querySelector(".zu-settings-feedback-status");
      if (!node) return;
      node.textContent = pending ? (state.pluginUpdate && state.pluginUpdate.feedbackVersion >= 1 ? L("操作已发出，等待确认…", "Sent; awaiting confirmation…") : L("操作已发出；保存确认需重启后端", "Sent; restart the backend for save confirmation")) : error ? L("保存失败，请重试", "Save failed; try again") : L("已保存", "Saved");
      node.classList.toggle("zu-feedback-error", !!error);
    }
    function showSourceFeedback(id, error, pending) {
      sourceFeedback[id] = { error: !!error, pending: !!pending };
      var rows = panel.querySelectorAll(".zu-src-row[data-src]");
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute("data-src") !== String(id)) continue;
        var node = rows[i].querySelector(".zu-src-feedback");
        if (!node) return;
        node.textContent = pending ? (state.pluginUpdate && state.pluginUpdate.feedbackVersion >= 1 ? L("操作已发出，等待确认…", "Sent; awaiting confirmation…") : L("操作已发出；保存确认需重启后端", "Sent; restart the backend for save confirmation")) : error ? L("操作失败，请重试", "Action failed; try again") : L("已保存", "Saved");
        node.classList.toggle("zu-feedback-error", !!error);
        return;
      }
    }
    /* ---------- v132 模型拉取（收编 zcode-model-puller，挂宿主设置页）----------
     * 挂载点：官方「模型设置 → 自定义供应商」的「+ 添加模型」按钮左侧（锚
     * data-testid=model-provider-add-model-button），与额度 chip 同款 enhance/restore
     * 契约（render/heavy 双对账 + 位置兜回，React 不清理手动属性/兄弟节点）。
     * 供应商归属：优先读设置页表单里的 http(s) Base URL 匹配主进程供应商列表，唯一命中
     * 直接拉取；否则单供应商直用、多供应商弹选择。模型 id 是远端 /models 响应内容，弹窗
     * 全部 innerHTML 拼接处经 mEsc 转义。mpAsk 25s 兜底：旧主进程不识别 action 时提示
     * 完全重启而非永久 loading。 */
    var mpModal = null, mpHostBtn = null;
    var MP_HOST_ANCHOR = '[data-testid="model-provider-add-model-button"]';
    function mEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function mpAsk(action, extra, done) {
      var settled = false;
      var finish = function (result) { if (settled) return; settled = true; clearTimeout(timer); done(result || { ok: false, error: "no response" }); };
      /* 25s：主进程最坏路径 = 目录 5s 并行 + 双候选端点各 10s 串行 ≈ 20s，留 5s 余量防假超时 */
      var timer = setTimeout(function () { finish(null); }, 25000);
      pluginRequest(action, extra, finish);
    }
    function mpErrorText(err) {
      var s = (err && err.error) || err || "";
      if (s === "no response") {
        return L("请求超时：多候选端点全部无响应，或主进程仍是旧版（模型拉取需完全退出并重开 ZCode 加载）。", "Timed out: every candidate endpoint hung, or the main process is outdated (fully quit and reopen ZCode to load model pulling).");
      }
      if (s === "unavailable") {
        return L("主进程可能仍是旧版：模型拉取需完全退出并重开 ZCode 加载。", "The main process may be outdated: fully quit and reopen ZCode to load model pulling.");
      }
      return String(s);
    }
    /* 弹窗行元数据（v130）：ctx/out 可见小字，档位与全量进 title；数值 k/M 紧凑格式。
     * issue #236：无任何证据（无 meta 或全空）时给「未获取配置」中性小字，不再静默按默认写入；
     * 主进程目录补拉中（effortsFetching）时换成「档位补拉中…」状态，用户知道在等什么。 */
    function mpMetaParts(meta, fetching) {
      if (!meta || (!meta.contextWindow && !meta.maxOutputTokens && !(meta.efforts && meta.efforts.length))) {
        if (fetching) {
          return {
            visible: L("档位补拉中…", "efforts pulling…"),
            title: L("思考档位目录正在后台补拉，完成后重新拉取即可显示", "The reasoning-level catalog is being fetched in the background; pull again once it lands"),
          };
        }
        return {
          visible: L("未获取配置", "no config fetched"),
          title: L("未获取到提供商侧配置，写入后保持 ZCode 默认（思考档位/上下文等可在模型设置手动调整）", "No provider-side config fetched; ZCode defaults apply after sync (adjust reasoning/context in model settings)"),
        };
      }
      var fmt = function (n) {
        n = +n;
        if (!isFinite(n) || n <= 0) return "";
        if (n >= 1000000) return (Math.round(n / 100000) / 10) + "M";
        if (n >= 1000) return Math.round(n / 1000) + "k";
        return String(n);
      };
      var visible = [], title = [];
      if (meta.contextWindow) { visible.push(L("上下文 " + fmt(meta.contextWindow), "ctx " + fmt(meta.contextWindow))); title.push("ctx " + fmt(meta.contextWindow)); }
      if (meta.maxOutputTokens) { visible.push(L("输出 " + fmt(meta.maxOutputTokens), "out " + fmt(meta.maxOutputTokens))); title.push("out " + fmt(meta.maxOutputTokens)); }
      if (meta.efforts && meta.efforts.length) title.push(L("思考档位 ", "reasoning ") + meta.efforts.join("/"));
      if (!visible.length && !title.length) return null;
      return { visible: visible.join(" · "), title: title.join(" · ") };
    }
    /* 通用弹窗壳：body 级遮罩（面板同族变量配色），Esc/遮罩/✕ 关闭，返回遮罩节点供调用方绑内容事件 */
    function openMpShell(titleText, bodyHtml) {
      cleanupMpModal();
      var ov = document.createElement("div");
      ov.className = "zu-mp-ov";
      ov.innerHTML = '<div class="zu-mp-modal" role="dialog" aria-modal="true" aria-label="' + mEsc(titleText || L("选择要同步的模型", "Choose models to sync")) + '">' +
        (titleText ? '<div class="zu-mp-head"><div class="zu-mp-title">' + mEsc(titleText) + '</div>' +
        '<button type="button" class="zu-mp-close" aria-label="' + L("关闭", "Close") + '">✕</button></div>' :
        '<button type="button" class="zu-mp-close zu-mp-close-abs" aria-label="' + L("关闭", "Close") + '">✕</button>') + bodyHtml + "</div>";
      ov.classList.toggle("zu-light", !themeDark);   // 弹窗不在 bar 作用域，自带类随主题换装
      document.body.appendChild(ov);
      mpModal = ov;
      mpModalDispose = cleanupMpModal;
      mpModalThemeSync = function (lite) { ov.classList.toggle("zu-light", lite); };
      ov.querySelector(".zu-mp-close").addEventListener("click", cleanupMpModal);
      ov.addEventListener("mousedown", function (e) { if (e.target === ov) cleanupMpModal(); });
      function onEsc(e) { if (e.key === "Escape") cleanupMpModal(); }
      document.addEventListener("keydown", onEsc);
      ov.__zuMpEsc = onEsc;
      return ov;
    }
    /* 模型选择弹窗：勾选（已添加默认不选/新模型默认全选）、搜索、快捷批选，确认后
     * model-pull-apply 最小写回；成功即关闭，宿主模型列表数秒内自动刷新。 */
    function openMpModal(provider, models, metaById, effortsFetching) {
      var metaById2 = metaById || Object.create(null);   // 与 v130 纪律一致：远端数据键一律 null 原型
      var existing = Object.create(null);   // null 原型：模型 id 来自远端，"__proto__" 等键必须可写
      for (var i = 0; i < provider.modelIds.length; i++) existing[provider.modelIds[i]] = true;
      var sel = Object.create(null), newCount = 0;
      for (i = 0; i < models.length; i++) { sel[models[i]] = !existing[models[i]]; if (sel[models[i]]) newCount++; }
      var rows = "";
      for (i = 0; i < models.length; i++) {
        var mid = models[i];
        var meta = mpMetaParts(metaById2[mid], effortsFetching);
        rows += '<label class="zu-mp-item" data-mpid="' + mEsc(mid) + '" title="' + mEsc(meta ? meta.title : mid) + '"><input type="checkbox" data-mpid="' + mEsc(mid) + '"' + (sel[mid] ? " checked" : "") + ">" +
          '<span class="zu-mp-id">' + mEsc(mid) + "</span>" +
          (meta && meta.visible ? '<span class="zu-mp-meta">' + mEsc(meta.visible) + "</span>" : "") +
          (existing[mid] ? '<span class="zu-mp-badge zu-mp-old">' + L("已添加", "Added") + "</span>"
            : '<span class="zu-mp-badge zu-mp-new">' + L("新模型", "New") + "</span>") + "</label>";
      }
      var ov = openMpShell("",
        '<div class="zu-mp-head2"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="zu-mp-bolt"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>' +
        '<span class="zu-mp-title">' + mEsc(L("选择要同步的模型 (共 " + models.length + " 个，待添加新模型 " + newCount + " 个)", "Choose models to sync (" + models.length + " total, " + newCount + " new)")) + "</span></div>" +
        '<div class="zu-mp-sub">' + mEsc(provider.name || provider.id) + "</div>" +
        '<div class="zu-mp-tools"><input type="text" class="zu-mp-search" placeholder="' + L("搜索模型名称…", "Search model names…") + '" aria-label="' + L("搜索模型", "Search models") + '">' +
        '<div class="zu-mp-quick"><button type="button" class="zu-mp-all">' + L("全选", "All") + "</button>" +
        '<button type="button" class="zu-mp-none">' + L("清空", "None") + "</button>" +
        '<button type="button" class="zu-mp-fresh">' + L("仅选新模型", "New only") + " (" + newCount + ")</button></div></div>" +
        '<div class="zu-mp-items">' + rows + "</div>" +
        (effortsFetching ? '<div class="zu-mp-note">' + mEsc(L("思考档位目录正在后台补拉（约数 MB，不阻塞本轮），完成后重新拉取即可显示档位。", "The reasoning-level catalog is being fetched in the background (a few MB, non-blocking); pull again once it lands to show levels.")) + "</div>" : "") +
        '<div class="zu-mp-note">' + mEsc(L("仅新增写入：已有配置的模型不会被覆盖；未获取到配置的模型保持 ZCode 默认值。", "Append-only: existing configs are never overwritten; models without fetched config keep ZCode defaults.")) + "</div>" +
        '<div class="zu-mp-err" role="status" aria-live="polite"></div>' +
        '<div class="zu-mp-foot"><span class="zu-mp-count"></span>' +
        '<div class="zu-mp-actions"><button type="button" class="zu-mp-cancel">' + L("取消", "Cancel") + "</button>" +
        '<button type="button" class="zu-mp-ok">' + L("确认添加并保存", "Confirm and save") + ' (<span class="zu-mp-okn">0</span>)</button></div></div>');
      var items = ov.querySelector(".zu-mp-items");
      var countNode = ov.querySelector(".zu-mp-count");
      var okBtn = ov.querySelector(".zu-mp-ok");
      var errNode = ov.querySelector(".zu-mp-err");
      function refreshCounts() {
        var n = 0;
        for (var k in sel) if (Object.prototype.hasOwnProperty.call(sel, k) && sel[k]) n++;
        countNode.textContent = L("已选中 " + n + " / " + models.length + " 个模型", n + " / " + models.length + " selected");
        ov.querySelector(".zu-mp-okn").textContent = String(n);
        okBtn.disabled = n === 0;
      }
      items.addEventListener("change", function (e) {
        var id = e.target.getAttribute && e.target.getAttribute("data-mpid");
        if (id == null || !Object.prototype.hasOwnProperty.call(sel, id)) return;
        sel[id] = e.target.checked;
        refreshCounts();
      });
      ov.querySelector(".zu-mp-search").addEventListener("input", function (e) {
        var kw = e.target.value.toLowerCase().trim();
        var nodes = items.querySelectorAll(".zu-mp-item");
        for (var j = 0; j < nodes.length; j++) {
          nodes[j].hidden = nodes[j].getAttribute("data-mpid").toLowerCase().indexOf(kw) < 0;
        }
      });
      function setAll(value, onlyNew) {
        var nodes = items.querySelectorAll(".zu-mp-item");
        for (var j = 0; j < nodes.length; j++) {
          var id = nodes[j].getAttribute("data-mpid");
          var v = onlyNew ? !existing[id] : value;
          sel[id] = v;
          var cb = nodes[j].querySelector("input");
          if (cb) cb.checked = v;
        }
        refreshCounts();
      }
      ov.querySelector(".zu-mp-all").addEventListener("click", function () { setAll(true, false); });
      ov.querySelector(".zu-mp-none").addEventListener("click", function () { setAll(false, false); });
      ov.querySelector(".zu-mp-fresh").addEventListener("click", function () { setAll(false, true); });
      ov.querySelector(".zu-mp-cancel").addEventListener("click", cleanupMpModal);
      refreshCounts();
      okBtn.addEventListener("click", function () {
        var picked = [];
        for (var j = 0; j < models.length; j++) if (sel[models[j]]) picked.push(models[j]);
        if (!picked.length) return;
        okBtn.disabled = true;
        okBtn.firstChild.nodeValue = L("正在保存…", "Saving…") + " (";
        errNode.textContent = "";
        mpAsk("model-pull-apply", { providerId: provider.id, models: picked }, function (result) {
          if (inactive()) return;
          if (result && result.ok) {
            cleanupMpModal();   // 写回完成：宿主模型列表数秒内自动刷新
            return;
          }
          okBtn.disabled = false;
          okBtn.firstChild.nodeValue = L("确认添加并保存", "Confirm and save") + " (";
          errNode.textContent = mpErrorText(result);
        });
      });
    }
    function cleanupMpModal() {
      if (!mpModal) return;
      if (mpModal.__zuMpEsc) document.removeEventListener("keydown", mpModal.__zuMpEsc);
      mpModal.remove();
      mpModal = null;
      mpModalDispose = null;
      mpModalThemeSync = null;
    }
    /* 供应商归属（v132 读宿主源码定案，主判定=当前选择的供应商）：左侧导航项
     * testid=model-provider-nav-item-<nodeKey>，custom 供应商 nodeKey=custom:<providerId>
     * （utils.tsx createCustomProviderNodeKey），选中项 data-state="selected"（Navigation.tsx）
     * ——取选中 custom 项的 providerId 与主进程列表精确匹配，编辑草稿未保存也不影响归属。
     * 兜底链：Base URL 匹配（专用 testid model-provider-base-url-input 优先，表单启发式探测
     * 次之）→ 单供应商直用 → 多供应商弹选择。preset/套餐导航项（非 custom: 前缀）不误归属。 */
    function detectSelectedCustomProviderId(anchor) {
      try {
        var nodes = document.querySelectorAll('[data-testid^="model-provider-nav-item-"][data-state="selected"]');
        for (var i = 0; i < nodes.length; i++) {
          var nodeKey = (nodes[i].getAttribute("data-testid") || "").replace(/^model-provider-nav-item-/, "");
          try { window.__zusageDiag.mpSel = nodeKey.slice(0, 140); } catch (e) { }   // 诊断：真实选中 nodeKey 形态
          var m = /^custom:(.+)$/.exec(nodeKey);
          if (m) return m[1];
          /* v134 内置套餐源：BigModel 付费套餐详情页可拉取（OAuth token 对 anthropic
           * models 端点有效，实测 200）。实机诊断：BigModel 导航项与 Start Plan 导航项
           * 共用 nodeKey=preset:account:bigmodel-start-plan——按详情内容区分：页内含
           * 付费卡（GLM Coding Max）才归属付费套餐；纯 Start Plan 免费卡页（模型由
           * 服务端随卡指定、无 models 端点实测 404）不放行不显示按钮 */
          if (/account:bigmodel-individual-coding-plan$/.test(nodeKey)) return nodeKey.slice(nodeKey.indexOf(":") + 1);
          if (/account:bigmodel-start-plan$/.test(nodeKey)) {
            var container = anchor, depth = 0, hasPaidCard = false;
            for (; container && container !== document.body && depth < 8; depth++) {
              container = container.parentElement;
              if (container && container.querySelector && container.querySelector('[data-testid="model-provider-enabled-switch"]')) break;
            }
            try {
              hasPaidCard = !!(container && container.textContent && container.textContent.indexOf("GLM Coding Max") >= 0);
            } catch (e) { }
            return hasPaidCard ? "account:bigmodel-individual-coding-plan" : "";
          }
        }
      } catch (e) { }
      return "";
    }
    function matchProviderById(providers, providerId) {
      var want = String(providerId || "");
      if (!want) return null;
      for (var i = 0; i < providers.length; i++) {
        if (String(providers[i].id) === want) return providers[i];
      }
      return null;
    }
    function matchProviderByBaseUrl(providers, baseUrl) {
      var want = String(baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
      if (!want) return null;
      var hits = [];
      for (var i = 0; i < providers.length; i++) {
        var b = String(providers[i].baseUrl || "").replace(/\/+$/, "").toLowerCase();
        if (b === want) hits.push(providers[i]);
      }
      return hits.length === 1 ? hits[0] : null;
    }
    function detectMpProviderBaseUrl(anchor) {
      try {
        var el = document.querySelector('[data-testid="model-provider-base-url-input"]');
        if (el) {
          var v = String(el.value || "").trim();
          if (/^https?:\/\//i.test(v)) return v;
        }
      } catch (e) { }
      var node = anchor;
      for (var i = 0; i < 8 && node && node !== document.body; i++) {
        node = node.parentElement;
        if (!node || !node.querySelectorAll) continue;
        var inputs = node.querySelectorAll("input:not([type=password]):not([type=checkbox]):not([type=radio])");
        if (inputs.length >= 2) {   // 表单容器（Base URL + 其它字段同框）
          for (var j = 0; j < inputs.length; j++) {
            var v = String(inputs[j].value || "").trim();
            if (/^https?:\/\//i.test(v)) return v;
          }
        }
      }
      return "";
    }
    function startMpHostFetch(provider, hostBtn) {
      mpAsk("model-pull-fetch", { providerId: provider.id }, function (result) {
        if (inactive()) return;
        if (hostBtn) setMpHostBusy(hostBtn, false);   // 弹窗出现/失败即解除（不再有异步步骤）
        if (!result || !result.ok) { openMpNotice(mpErrorText(result)); return; }
        openMpModal(provider, result.models || [], result.metaById || {}, result.effortsFetching);
      });
    }
    function openMpNotice(text) {
      openMpShell(L("模型拉取", "Model puller"), '<div class="zu-mp-note">' + mEsc(text) + "</div>");
    }
    function openMpProviders(providers) {
      var rows = "";
      for (var i = 0; i < providers.length; i++) {
        rows += '<button type="button" class="zu-mp-row zu-mp-pick" data-mp="' + mEsc(providers[i].id) + '">' +
          '<span class="zu-mp-name">' + mEsc(providers[i].name || providers[i].id) + "</span>" +
          '<span class="zu-mp-url">' + mEsc(providers[i].baseUrl) + "</span>" +
          '<span class="zu-mp-count">' + L("已有 " + providers[i].modelIds.length + " 个模型", providers[i].modelIds.length + " model(s) configured") + "</span></button>";
      }
      var ov = openMpShell(L("选择供应商", "Choose a provider"), '<div class="zu-mp-list">' + rows + "</div>");
      ov.addEventListener("click", function (e) {
        var pick = e.target.closest && e.target.closest(".zu-mp-pick");
        if (!pick) return;
        var id = pick.getAttribute("data-mp");
        for (var i = 0; i < providers.length; i++) {
          if (providers[i].id === id) { cleanupMpModal(); startMpHostFetch(providers[i]); return; }
        }
      });
    }
    function setMpHostBusy(btn, busy) {
      if (busy) {
        btn.setAttribute("aria-busy", "true");
        if (btn.lastChild && btn.lastChild.nodeType === 3) {
          btn.__zuMpLabel = btn.lastChild.nodeValue;
          btn.lastChild.nodeValue = L("拉取中…", "Pulling…");
        }
      } else {
        btn.removeAttribute("aria-busy");
        if (btn.__zuMpLabel && btn.lastChild && btn.lastChild.nodeType === 3) btn.lastChild.nodeValue = btn.__zuMpLabel;
      }
    }
    function onMpHostClick(e) {
      e.preventDefault();
      e.stopPropagation();
      if (inactive()) { restoreModelPuller(); return; }   // 热更后旧实例闭包不得再开弹窗
      var self = e.currentTarget;
      if (self.getAttribute("aria-busy") === "true") return;
      setMpHostBusy(self, true);   // loading 覆盖全程：list 是本地读取（毫秒级），真正的网络耗时在 fetch 阶段
      mpAsk("model-pull-list", undefined, function (result) {
        if (inactive()) { restoreModelPuller(); return; }
        var providers = result && result.ok && Array.isArray(result.providers) ? result.providers : null;
        if (!providers) { setMpHostBusy(self, false); openMpNotice(mpErrorText(result)); return; }
        if (!providers.length) {
          setMpHostBusy(self, false);
          openMpNotice(L("未找到 API Key 型自定义供应商：先在「模型设置 → 自定义供应商」里添加一个（填写 Base URL 与 API Key）再来。", "No API-key custom provider found: add one under Model settings first (base URL + API key), then pull."));
          return;
        }
        var provider = matchProviderById(providers, detectSelectedCustomProviderId(self))
          || matchProviderByBaseUrl(providers, detectMpProviderBaseUrl(self))
          || (providers.length === 1 ? providers[0] : null);
        if (provider) startMpHostFetch(provider, self);   // busy 延续到 fetch 回调（弹窗出现/失败才解除）
        else { setMpHostBusy(self, false); openMpProviders(providers); }
      });
    }
    /* 宿主设置页挂载（额度 chip 同款契约）：锚按钮左侧前插、幂等复用、位置兜回；
     * 设置页关即锚失 → restore 摘除。按钮视觉复刻原生 secondary 视格（同页 Tailwind
     * utility），⚡ 图标 stroke currentColor 与文字同色。 */
    function enhanceModelPuller() {
      if (inactive()) { restoreModelPuller(); return; }
      /* 锚 testid 全局唯一：内置/套餐页（BigModel/Start Plan）的「添加模型」同款 testid，
       * 但那些供应商的模型由宿主管——只有选中的是 custom 供应商时才挂按钮 */
      var btn = null;
      try { btn = document.querySelector(MP_HOST_ANCHOR); } catch (e) { }
      if (!detectSelectedCustomProviderId(btn)) { restoreModelPuller(); return; }
      try { window.__zusageDiag.mpAnchor = btn ? "1" : "0"; } catch (e) { }   // 诊断：锚按钮存在性
      if (!btn || !btn.parentElement) { restoreModelPuller(); return; }
      var wrap = btn.parentElement;
      var mine = mpHostBtn;
      if (!mine || !mine.isConnected || mine.parentElement !== wrap) {
        if (mine && mine.isConnected) mine.remove();
        mine = null;
        for (var i = 0; i < wrap.children.length; i++) {
          if (wrap.children[i].classList && wrap.children[i].classList.contains("zu-mp-host")) { mine = wrap.children[i]; break; }
        }
        if (!mine) {
          mine = document.createElement("button");
          mine.type = "button";
          mine.className = "zu-mp-host group/host inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors outline-none select-none gap-1 px-2 h-7 text-ui-base rounded-lg bg-secondary text-foreground hover:bg-secondary/80 border border-transparent disabled:pointer-events-none disabled:opacity-50 ml-auto";   /* ml-auto：锚容器是 justify-between，三子项会被均匀分布——吃掉剩余空间贴紧「添加模型」左侧 */
          mine.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:0 0 auto"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg>' + L("拉取模型", "Pull models");
          mine.addEventListener("click", onMpHostClick);
        }
        mpHostBtn = mine;
      }
      if (mine.nextElementSibling !== btn) wrap.insertBefore(mine, btn);   // 位置兜回：始终紧贴「添加模型」左侧
    }
    function restoreModelPuller() {
      if (mpHostBtn && mpHostBtn.isConnected) mpHostBtn.remove();
      mpHostBtn = null;
    }
    /* 源列表按推送状态增量重建（JSON 签名没变不重绘，避免打断正在输入的凭据框） */
    function syncQuotaSources() {
      var box = panel.querySelector(".zu-src-list");
      if (!box) return;
      var list = state.quotaSources || [];
      var sig = JSON.stringify([list, sourceFeedback]);
      if (sig === srcListSig && box.children && box.children.length) return;
      /* 正在输入凭据的源行不重建：状态推送（如别家查询完成）会翻转签名，重建会丢焦点丢内容 */
      try {
        var act = document.activeElement;
        if (act && act.classList && act.classList.contains("zu-src-field") && box.contains && box.contains(act)) return;
      } catch (e) { }
      srcListSig = sig;
      /* 源 id/label 可含用户自定义 provider 名（custom:<providerId> 等），经 innerHTML 拼接前
       * 统一转义；属性值经 HTML 解码读回，转义对 data-src 寻址透明。 */
      var aEsc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
      var html = "";
      for (var i2 = 0; i2 < list.length; i2++) {
        var sv = list[i2];
        var credFields = "";
        for (var f = 0; f < (sv.credentialFields || []).length; f++) {
          var field = sv.credentialFields[f];
          var isCred = field === "apiKey" || field === "cookie" || field === "token" || field === "secretAccessKey";
          credFields += '<input type="' + (isCred ? "password" : "text") + '" class="zu-src-field" data-src="' + aEsc(sv.id) +
            '" data-field="' + aEsc(field) + '" placeholder="' + aEsc((SRC_FIELD_LABELS || {})[field] || field) +
            (isCred && sv.keyConfigured ? L("（已配置，输入以更换）", " (configured)") : "") + '" autocomplete="off">';
        }
        var pr = sv.presets || [], chips = "", curBase = String(sv.baseUrl || "").replace(/\/+$/, "");
        for (var p2 = 0; p2 < pr.length; p2++) {
          chips += '<button type="button" class="zu-src-preset' + (curBase && curBase === String(pr[p2].value || "").replace(/\/+$/, "") ? " on" : "") +
            '" data-src="' + aEsc(sv.id) + '" data-base="' + aEsc(pr[p2].value) + '" title="' + aEsc(pr[p2].value) + '">' + L(pr[p2].label, pr[p2].labelEn || pr[p2].label) + '</button>';
        }
        html += '<div class="zu-src-row" data-src="' + aEsc(sv.id) + '">' +
          '<label class="zu-src-name"><input type="checkbox" class="zu-src-enable" data-src="' + aEsc(sv.id) + '"' + (sv.enabled ? " checked" : "") + '>' +
          '<span>' + aEsc(sv.label) + (sv.unverified ? "*" : "") + '</span></label>' +
          '<span class="zu-src-status" role="status" aria-live="polite">' + srcStatusText(sv) + '</span>' +
          (sv.keyUrl ? '<button type="button" class="zu-src-keyurl" data-url="' + aEsc(sv.keyUrl) + '" aria-label="' + L("打开控制台获取 API Key", "Open the console to get an API key") + '" title="' + L("打开控制台获取 API Key", "Open the console to get an API key") + '">' + L("获取 Key ↗", "Get key ↗") + '</button>' : "") +
          '<button type="button" class="zu-src-refresh" data-src="' + aEsc(sv.id) + '" aria-label="' + L("立即刷新", "Refresh now") + '" title="' + L("跳过缓存，立即重新查询该源", "Re-query this source now, skipping the cache") + '"' + (sv.enabled && !sv.busy ? "" : " disabled") + ' aria-busy="' + (!!sv.busy) + '">↻</button>' +
          (chips ? '<span class="zu-src-presets">' + chips + '</span>' : "") +
          '<span class="zu-src-fields">' + credFields + '</span>' +
          '<span class="zu-src-feedback' + (sourceFeedback[sv.id] && sourceFeedback[sv.id].error ? ' zu-feedback-error' : '') + '" role="status" aria-live="polite">' +
          (sourceFeedback[sv.id] ? sourceFeedback[sv.id].pending ? (state.pluginUpdate && state.pluginUpdate.feedbackVersion >= 1 ? L("操作已发出，等待确认…", "Sent; awaiting confirmation…") : L("操作已发出；保存确认需重启后端", "Sent; restart the backend for save confirmation")) : sourceFeedback[sv.id].error ? L("操作失败，请重试", "Action failed; try again") : L("已保存", "Saved") : "") + '</span></div>';
      }
      box.innerHTML = html;
    }
    /* 更新进度条（v89）。主进程 updater 在 downloading/updating 阶段推送
     * progress = { stage: download|verify|install|sync, loaded?, total? }：
     * 下载条在 download 阶段按字节比例，之后一律 100%；安装条没有字节口径（宿主插件管理器
     * 不报进度），按校验→安装→同步三段推进并用扫光表示仍在活动。旧版主进程不带 progress
     * 字段（热更新的渲染端先于主进程重启生效），此时整块隐藏，只保留原有状态文案。 */
    function formatBytes(n) {
      n = Math.max(0, +n || 0);
      if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
      if (n >= 1024) return Math.round(n / 1024) + " KB";
      return n + " B";
    }
    function setProgressBar(box, key, ratio, active, label) {
      var row = box.querySelector('[data-progress="' + key + '"]');
      if (!row) return;
      var pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
      var fill = row.querySelector(".zu-progress-fill");
      fill.style.width = pct + "%";
      fill.classList.toggle("active", !!active);
      row.querySelector(".zu-progress-track").setAttribute("aria-valuenow", String(pct));
      row.querySelector(".zu-progress-track").setAttribute("aria-label", key === "download" ? L("下载进度", "Download progress") : L("安装阶段", "Installation stage"));
      row.querySelector(".zu-progress-value").textContent = label;
    }
    function syncProgress(u) {
      var box = panel.querySelector(".zu-update-progress");
      if (!box) return;
      var p = u && u.progress;
      var show = !!(p && typeof p.stage === "string" && (u.phase === "downloading" || u.phase === "updating"));
      box.hidden = !show;
      if (!show) return;
      var idx = PROGRESS_STAGES.indexOf(p.stage);
      var total = +p.total > 0 ? +p.total : 0, loaded = Math.max(0, +p.loaded || 0);
      var dlRatio = idx > 0 ? 1 : (total ? loaded / total : 0);
      var dlLabel = idx > 0 ? "100%"
        : total ? Math.round(Math.min(1, loaded / total) * 100) + "% · " + formatBytes(loaded) + " / " + formatBytes(total)
        : formatBytes(loaded);
      setProgressBar(box, "download", dlRatio, idx <= 0, dlLabel);
      var install = {
        verify: [.15, L("校验中", "Verifying")],
        install: [.55, L("安装中", "Installing")],
        sync: [.9, L("同步中", "Syncing")],
      }[p.stage] || [0, L("等待下载完成", "Waiting for download")];
      setProgressBar(box, "install", install[0], idx > 0, install[1]);
    }
    function syncPanel() {
      panel.querySelectorAll('.zu-theme-choice').forEach(function (r) {
        r.checked = state.theme === r.value;
      });
      panel.querySelectorAll('.zu-just-choice').forEach(function (r) {
        r.checked = state.barJust === r.value;
      });
      panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
        cb.checked = !!state.show[cb.dataset.k];
      });
      panel.querySelector(".zu-ctxov").value = state.ctxOv;
      var rstCdhIn = panel.querySelector(".zu-rst-cdh");
      if (rstCdhIn) rstCdhIn.value = String(state.resetCdh);
      var kmbBox = panel.querySelector(".zu-force-kmb");
      if (kmbBox) kmbBox.checked = !!state.forceKmb;
      var cnBox = panel.querySelector(".zu-cn-num");
      if (cnBox) cnBox.checked = !!state.cnNum;
      var ppBox = panel.querySelector(".zu-pp-enable");
      if (ppBox) ppBox.checked = !!state.projPath;
      var ctxEnhBox = panel.querySelector(".zu-ctx-enh");
      if (ctxEnhBox) ctxEnhBox.checked = !!state.ctxEnh;
      var cptBox = panel.querySelector(".zu-cpt-btn");
      if (cptBox) cptBox.checked = !!state.ctxCpt;
      var costBox = panel.querySelector(".zu-cost-enable");
      if (costBox) costBox.checked = !!state.cost;
      var cwBox = panel.querySelector(".zu-cmdk-widen");
      if (cwBox) cwBox.checked = !!state.cmdkW;
      var tipClickBox = panel.querySelector(".zu-tip-click");
      if (tipClickBox) tipClickBox.checked = !!state.tipClick;
      var qrBox = panel.querySelector(".zu-quota-remain");
      if (qrBox) qrBox.checked = !!state.quotaRemain;
      if (typeof zuRotatorSyncPanel === "function") zuRotatorSyncPanel(panel);
      syncUpdate();
    }
    var relaunchAckTimer = 0;   /* v177：relaunch 回执超时（v244 起主进程回执随投递即返，含 1s 轮询约 1s 量级；超时≈旧主进程） */
    var relaunchAliveTimer = 0; /* v244：ok 回执后 90s 仍存活兜底——防状态机永久卡死；窗口可能已被 v245 hide，主进程 15s unhide 哨兵负责恢复可见 */
    panel.addEventListener("click", function (e) {
      if (typeof zuRotatorPanelClick === "function" && zuRotatorPanelClick(e, panel)) return;
      var navItem = e.target.closest && e.target.closest(".zu-navitem");
      if (navItem && navItem.getAttribute("data-sec") === "update") ackUpdateDots();   // v172：含已停留时再点
      if (navItem && !navItem.hasAttribute("aria-current")) {
        activateSettingsSec(navItem.dataset.sec);
        return;
      }
      if (e.target.closest && e.target.closest(".zu-settings-close")) {
        closeSettings(true);
        return;
      }
      if (e.target.closest && e.target.closest(".zu-settings-scroll")) {
        var body = panel.querySelector(".zu-settings-body");
        body.scrollTop += Math.max(1, Math.round(body.clientHeight * .8));
        syncSettingsScroll();
        return;
      }
      var presetBtn = e.target.closest && e.target.closest(".zu-src-preset");
      if (presetBtn) {
        if (presetBtn.dataset.src && presetBtn.dataset.base) pluginRequest("quota-src-key", { id: presetBtn.dataset.src, field: "baseUrl", value: presetBtn.dataset.base }, function (result) {
          if (!inactive()) showSourceFeedback(presetBtn.dataset.src, !result.ok, false);
        });
        return;
      }
      var srcBtn = e.target.closest && e.target.closest(".zu-src-refresh");
      if (srcBtn && !srcBtn.disabled) {
        pluginRequest("quota-src-refresh", { id: srcBtn.dataset.src });
        return;
      }
      if (e.target.closest && e.target.closest(".zu-settings-feedback")) {
        /* 优先走客户端 zcode 桥（IPC → 主进程 shell.openExternal，系统默认浏览器）；
           window.open 会被客户端内置浏览器接管，仅作无桥环境兜底 */
        var zc = window.zcode, issuesUrl = "https://github.com/ByteRax/zcode-token-usage-statusbar/issues";
        if (zc && typeof zc.openExternal === "function") zc.openExternal(issuesUrl);
        else window.open(issuesUrl, "_blank", "noopener");
        return;
      }
      /* ---------- v202 更新日志卡片交互 ---------- */
      var notesLnk = e.target.closest && e.target.closest(".zu-notes-lnk");
      if (notesLnk) {
        var notesUrl = notesLnk.getAttribute("data-href") || "";
        if (/^https:\/\//.test(notesUrl) && notesUrl.length <= 600) {   // 双重校验：渲染时已过滤，点击再验一次
          var zn = window.zcode;
          if (zn && typeof zn.openExternal === "function") zn.openExternal(notesUrl);
          else window.open(notesUrl, "_blank", "noopener");
        }
        return;
      }
      var notesHistBtn = e.target.closest && e.target.closest(".zu-notes-history-btn");
      if (notesHistBtn) {
        var notesHistPanel = panel.querySelector(".zu-notes-history");
        if (notesHistPanel) {
          notesHistPanel.hidden = !notesHistPanel.hidden;
          notesHistorySig = "";
          if (!notesHistPanel.hidden && (notesHistoryState === "" ||
              (notesHistoryState === "done" && notesHistoryError && !notesHistory))) requestNotesList(false);   // 首次展开或上次失败：重新拉取
          renderNotesHistory();
        }
        return;
      }
      var notesHistItem = e.target.closest && e.target.closest(".zu-notes-hist-item");
      if (notesHistItem && notesHistItem.getAttribute("data-version")) {
        notesSel = { version: notesHistItem.getAttribute("data-version"), explicit: true };   // 粘性：轮询不切回
        renderNotesHistory();
        syncNotes();
        return;
      }
      var notesRetryBtn = e.target.closest && e.target.closest(".zu-notes-retry");
      if (notesRetryBtn && !notesRetryBtn.hidden) {
        var retryTarget = notesPickTarget(state.pluginUpdate).target;
        if (retryTarget && retryTarget.version) requestNotes(retryTarget.version, true);
        return;
      }
      var notesHistRetryBtn = e.target.closest && e.target.closest(".zu-notes-hist-retry");
      if (notesHistRetryBtn) {
        requestNotesList(true);   // force：绕过缓存重拉历史列表
        return;
      }
      var notesToggleBtn = e.target.closest && e.target.closest(".zu-notes-toggle");
      if (notesToggleBtn && !notesToggleBtn.hidden) {
        notesExpanded = !notesExpanded;
        syncNotes();
        return;
      }
      var notesLinkBtn = e.target.closest && e.target.closest(".zu-notes-link");
      if (notesLinkBtn && !notesLinkBtn.hidden) {
        var notesPageUrl = notesLinkBtn.getAttribute("data-href") || "";
        if (/^https:\/\//.test(notesPageUrl) && notesPageUrl.length <= 600) {
          var zp = window.zcode;
          if (zp && typeof zp.openExternal === "function") zp.openExternal(notesPageUrl);
          else window.open(notesPageUrl, "_blank", "noopener");
        }
        return;
      }
      var notesBackBtn = e.target.closest && e.target.closest(".zu-notes-back");
      if (notesBackBtn) {
        notesSel = { version: "", explicit: false };   // 回到默认目标（安装状态已变化时也由此收敛）
        syncNotes();
        return;
      }
      var button = e.target.closest && e.target.closest("[data-update]");
      if (button && !button.disabled) {
        if (button.dataset.update !== "relaunch") { pluginRequest(button.dataset.update); return; }
        var pu = state.pluginUpdate;
        if (pu && pu.relaunchSupported !== true) {   // v180 issue #158：防能力标记首推前的渲染窗口——主进程无 relaunch 能力时不发指令，直接给手动指引
          button.dataset.armed = "0";
          if (!pu.restartRequired) button.classList.remove("zu-rr-armed");   // 待重启高亮仍由 syncUpdate 按 restartRequired 校正
          button.textContent = L("重启 ZCode", "Restart ZCode");
          var puEl = panel.querySelector(".zu-update-status");
          if (puEl) puEl.textContent = L("「重启 ZCode」需要新版主进程支持：当前主进程是旧版本，请完全退出 ZCode 后重新打开。", "Restarting ZCode needs a newer main process: the running main process is outdated — quit ZCode completely and reopen it.");
          return;
        }
        /* v172 重启会关闭所有窗口：二次确认（首次变确认文案，5s 未再点还原）再发 relaunch 动作。
         * v244 退出等待期可达数十秒（宿主 app.quit 优雅退出链要关窗并逐个终止会话/扩展子进程）：
         * 发出即进入「正在重启…」禁用态并写预期文案，不再「发出即恢复」伪装无反应；
         * 4s 无回执 / ok:false 失败 / 90s 仍存活三路全部还原按钮。 */
        if (button.dataset.armed === "1") {
          button.dataset.armed = "0";
          if (!(state.pluginUpdate && state.pluginUpdate.restartRequired)) button.classList.remove("zu-rr-armed");
          button.dataset.sent = "1";   // syncUpdate 状态推送重建状态行时据此保持禁用与提示
          button.disabled = true;
          button.textContent = L("正在重启…", "Restarting…");
          var stEl = panel.querySelector(".zu-update-status");
          if (stEl) stEl.textContent = L("已发出重启请求：ZCode 正在退出全部窗口并自动重新打开；等待会话与扩展子进程退出通常需要几秒到几十秒，请稍候。", "Restart request sent: ZCode is closing all windows and will reopen automatically; waiting for session and extension child processes to exit can take a few seconds to tens of seconds.");
          if (relaunchAckTimer) clearTimeout(relaunchAckTimer);
          relaunchAckTimer = setTimeout(function () {
            relaunchAckTimer = 0;
            /* v177：旧 pollPluginRequests 白名单外动作 splice 后静默丢弃（无 ok:false 回执）——
             * 超时明确告知手动完全退出；v244 起同时还原「正在重启」态。 */
            button.dataset.sent = "";
            button.disabled = false;
            button.textContent = L("重启 ZCode", "Restart ZCode");
            var stEl = panel.querySelector(".zu-update-status");
            if (stEl) stEl.textContent = L("未收到重启回执：ZCode 主进程可能是旧版，请手动完全退出并重新打开。", "No receipt for the restart request; the ZCode main process may be outdated — quit ZCode completely and reopen it manually.");
          }, 4000);
          pluginRequest("relaunch", undefined, function (result) {
            if (relaunchAckTimer) { clearTimeout(relaunchAckTimer); relaunchAckTimer = 0; }
            if (result && result.ok === false) {
              button.dataset.sent = "";
              button.disabled = false;
              button.textContent = L("重启 ZCode", "Restart ZCode");
              var stEl = panel.querySelector(".zu-update-status");
              if (stEl) stEl.textContent = /^unknown action:/.test(String(result.error || ""))
                ? L("重启请求未被识别：ZCode 主进程是旧版本，请完全退出 ZCode 后重新打开。", "The restart request was not recognized: the ZCode main process is outdated — quit ZCode completely and reopen it.")
                : L("重启请求失败：", "Restart failed: ") + (result.error || "");
            } else if (result && result.ok && button.dataset.sent === "1") {
              /* v244：ok 后保持「正在重启」态（状态文案发送时已写，回执不改写）；挂 90s 仍存活
               * 兜底——quit 被会话/扩展阻止时按钮不能永久卡死（4s 超时已还原则跳过）。
               * 正常路径渲染进程随窗口退出先于本定时器消亡，回调不再执行。 */
              if (relaunchAliveTimer) clearTimeout(relaunchAliveTimer);
              relaunchAliveTimer = setTimeout(function () {
                relaunchAliveTimer = 0;
                button.dataset.sent = "";
                button.disabled = false;
                button.textContent = L("重启 ZCode", "Restart ZCode");
                var stEl = panel.querySelector(".zu-update-status");
                if (stEl) stEl.textContent = L("ZCode 仍未退出（可能被会话或扩展子进程阻止）：可再次点击重启，或手动完全退出后重新打开。", "ZCode has not exited (it may be blocked by a session or extension child process): click restart again, or quit ZCode completely and reopen it.");
              }, 90000);
            }
          });
        } else {
          button.dataset.armed = "1";
          button.classList.add("zu-rr-armed");
          button.textContent = L("再次点击确认重启", "Click again to confirm restart");
          setTimeout(function () {
            if (button.dataset.armed === "1") {
              button.dataset.armed = "0";
              if (!(state.pluginUpdate && state.pluginUpdate.restartRequired)) button.classList.remove("zu-rr-armed");
              button.textContent = L("重启 ZCode", "Restart ZCode");
            }
          }, 5000);
        }
        return;
      }
      var keyBtn = e.target.closest && e.target.closest(".zu-src-keyurl");
      if (keyBtn) {
        /* 获取 Key：走客户端 openExternal 桥（系统默认浏览器），无桥环境 window.open 兜底 */
        var ku = keyBtn.getAttribute("data-url") || "";
        if (ku) {
          var zk = window.zcode;
          if (zk && typeof zk.openExternal === "function") zk.openExternal(ku);
          else window.open(ku, "_blank", "noopener");
        }
        return;
      }
    });
    gear.addEventListener("click", function (e) {
      e.stopPropagation();
      var opening = !panel.classList.contains("open");
      if (!opening) { closeSettings(true); return; }
      previousPanelFocus = document.activeElement;
      syncPanel();
      /* v172：持久化分区停在「插件更新」时打开面板即已查看；
       * v208：有待重启红点且未查看时直接落到「插件更新」分区（激活即 ack，红点灭），确保立刻看到提示与重启按钮 */
      if (activeSettingsSec() === "update") ackUpdateDots();
      else if (updDotOn()) activateSettingsSec("update");
      panel.classList.add("open");
      panel.setAttribute("aria-modal", "false");
      gear.setAttribute("aria-expanded", "true");
      panel.style.height = "";   // v101：重开时按当前分区内容重测高度（开着的期间高度锁死）
      positionSettingsPanel();
      subPopClose(false, "gear-open");   // 与子代理统一浮层互斥（v49→v217）
      hideTip(true, "gear-open");   // 移向齿轮的路上可能触发过条目 tooltip，开面板时一并收掉
      var activeNav = panel.querySelector('.zu-navitem[aria-current="page"]');
      if (activeNav) activeNav.focus();
    });
    panel.addEventListener("input", function (e) {
      var field = e.target;
      if (field.classList && field.classList.contains("zu-src-field")) field.__zuEditVersion = (field.__zuEditVersion || 0) + 1;
    });
    panel.addEventListener("change", function (e) {
      var t2 = e.target;
      if (typeof zuRotatorPanelChange === "function" && zuRotatorPanelChange(e, panel)) return;
      if (t2.classList.contains("zu-theme-choice")) {
        if (t2.checked && (t2.value === "default" || t2.value === "pill" || t2.value === "compact")) {
          if (ls(LS.autoCompact, "")) lsSet(LS.autoCompact, "");   // v226：手动改档即解除全关自动精简（无标记不写，保持持久化写面干净）
          setBarTheme(t2.value);
        }
        return;
      }
      if (t2.classList.contains("zu-just-choice")) {
        if (t2.checked) setBarJust(t2.value);   // v226：默认样式水平对齐（均分/居左/居右）
        return;
      }
      if (t2.classList.contains("zu-auto-update")) {
        pluginRequest("auto", t2.checked);
        return;
      }
      if (t2.classList.contains("zu-restart-notice")) {
        /* 乐观更新勾选态，真值以主进程写 config.json 后回推的 restartNotice 为准 */
        var requestedNotice = t2.checked, previousNotice = state.restartNotice;
        state.restartNotice = requestedNotice;
        showSettingsFeedback(false, true);
        pluginRequest("restart-notice", requestedNotice, function (result) {
          if (inactive()) return;
          if (result.ok) { showSettingsFeedback(false, false); return; }
          state.restartNotice = previousNotice;
          syncPanel();
          showSettingsFeedback(true);
        });
        return;
      }
      if (t2.classList.contains("zu-src-enable")) {
        var sourceToggle = t2, sourceWasEnabled = !t2.checked;
        showSourceFeedback(t2.dataset.src, false, true);
        pluginRequest("quota-src", { id: t2.dataset.src, enabled: t2.checked }, function (result) {
          if (inactive()) return;
          if (!result.ok) sourceToggle.checked = sourceWasEnabled;
          showSourceFeedback(sourceToggle.dataset.src, !result.ok, false);
        });
        return;
      }
      if (t2.classList.contains("zu-src-field")) {
        if (t2.dataset.src && t2.dataset.field) {
          var field = t2, editVersion = field.__zuEditVersion || 0;
          showSourceFeedback(field.dataset.src, false, true);
          pluginRequest("quota-src-key", { id: field.dataset.src, field: field.dataset.field, value: field.value }, function (result) {
            if (inactive()) return;
            if (result.ok && field.type === "password" && document.activeElement !== field && (field.__zuEditVersion || 0) === editVersion) field.value = "";
            showSourceFeedback(field.dataset.src, !result.ok, false);
          });
        }
        return;
      }
      if (t2.classList.contains("zu-quota-enable")) {
        /* v95：乐观更新，真值以主进程写 config.json 的 quota_enabled 后回推为准；关闭时
           chip 在下一次 heavy 对账点摘除，主进程停止解密与联网 */
        var requestedQuota = t2.checked;
        var previousQuota = state.quotaEnabled;
        state.quotaEnabled = requestedQuota;
        showSettingsFeedback(false, true);
        pluginRequest("quota", requestedQuota, function (result) {
          if (inactive()) return;
          if (result.ok) { showSettingsFeedback(false, false); return; }
          state.quotaEnabled = previousQuota;
          syncPanel();
          showSettingsFeedback(true);
        });
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-rst-enable")) {
        /* v135：乐观更新，真值以主进程写 config.json 的 reset_badge_enabled 后回推为准 */
        var requestedRst = t2.checked;
        var previousRst = state.resetBadge;
        state.resetBadge = requestedRst;
        showSettingsFeedback(false, true);
        pluginRequest("quota-reset", requestedRst, function (result) {
          if (inactive()) return;
          if (result.ok) { showSettingsFeedback(false, false); return; }
          state.resetBadge = previousRst;
          syncPanel();
          showSettingsFeedback(true);
        });
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-ac-enable")) {
        /* v179：乐观更新，真值以主进程打补丁/还原后回推的 enginePatch 为准。
           补丁即时写引擎文件；已运行 agent 子进程保持旧代码，下个 spawn/重启起用。 */
        var requestedAc = t2.checked;
        var previousAc = !!(state.enginePatch && state.enginePatch.enabled);
        if (state.enginePatch) state.enginePatch.enabled = requestedAc;
        showSettingsFeedback(false, true);
        pluginRequest("autocompact-patch", requestedAc, function (result) {
          if (inactive()) return;
          if (result.ok) {
            if (result.enginePatch) state.enginePatch = result.enginePatch;
            showSettingsFeedback(false, false);
          } else {
            if (state.enginePatch) state.enginePatch.enabled = previousAc;
            showSettingsFeedback(true);
          }
          syncAutoCompactInputs();
        });
        return;
      }
      if (t2.classList.contains("zu-rate-line")) {
        /* 乐观更新勾选态，真值以主进程写 config.json 后回推的 rateLine 为准 */
        var requestedRateLine = t2.checked;
        var previousRateLine = state.rateLine;
        state.rateLine = requestedRateLine;
        scanRateLines();
        scanDeterministicLines();   // v71：关=撤下确定性历史行，开=立即重扫补行
        showSettingsFeedback(false, true);
        pluginRequest("rate-line", requestedRateLine, function (result) {
          if (inactive()) return;
          if (result.ok) { showSettingsFeedback(false, false); return; }
          state.rateLine = previousRateLine;
          scanRateLines();
          scanDeterministicLines();
          syncPanel();
          showSettingsFeedback(true);
        });
        return;
      }
      if (t2.classList.contains("zu-force-kmb")) {
        /* v173：独立持久化（不进 persist 批量写），避免多窗口旧快照互相覆盖 */
        var nextForceKmb = t2.checked ? 1 : 0;
        if (nextForceKmb !== state.forceKmb) {
          richTextUnitEpoch++;
          richTextAttempts = {};
        }
        state.forceKmb = nextForceKmb;
        lsSet(LS.forceKmb, state.forceKmb ? "1" : "0");
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-cn-num")) {
        var nextCn = t2.checked ? 1 : 0;
        if (nextCn !== state.cnNum) {
          /* v177：与 forceKmb 同款在途竞态守卫——切换前在途的旧单位 turn-text 响应
           * 被 epoch 守卫拒绝，不再以旧万/亿格式写进缓存（已缓存行按契约不重算） */
          richTextUnitEpoch++;
          richTextAttempts = {};
        }
        state.cnNum = nextCn;
        persist();
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-pp-enable")) {
        /* v136：纯展示偏好存 localStorage；<html> 属性门控样式即时生效，无需重建 */
        state.projPath = t2.checked ? 1 : 0;
        persist();
        applyProjPath();
        return;
      }
      if (t2.classList.contains("zu-ctx-enh")) {
        /* v156：增强开关即时生效——下一拍 render/heavy 对账走 enhanceCtxButton 的关闭分支
         * 还原/重挂；这里直接调一次让按钮形态立即切换，不等对账周期 */
        state.ctxEnh = t2.checked ? 1 : 0;
        persist();
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-cpt-btn")) {
        /* v200：压缩按钮开关即时生效——关闭立即摘除弹层内已注入按钮（确认框理论上进
         * 不到这里：弹框遮罩挡住齿轮，兜底关掉），开启即重挂；阈值行/说明行同拍顶到
         * 按钮原位，不等 Observer/heavy 对账周期 */
        state.ctxCpt = t2.checked ? 1 : 0;
        persist();
        if (!state.ctxCpt && compactDlg) closeCompactDlg();
        syncCompactBtn();
        return;
      }
      if (t2.classList.contains("zu-cost-enable")) {
        /* v202：费用行开关即时生效——纯展示偏好，立即重渲染让四格 tooltip/模型明细/
         * 紧凑摘要同拍带上或去掉费用行 */
        state.cost = t2.checked ? 1 : 0;
        persist();
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-quota-remain")) {
        /* v251：额度显示口径切换——纯渲染偏好，立即重渲染让 chip 面分段数字与 aria、
         * 悬停明细（quotaTip）同拍改口径；档位色不受影响（恒按已用判定） */
        state.quotaRemain = t2.checked ? 1 : 0;
        persist();
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-cmdk-widen")) {
        /* v146：同款纯展示偏好 + <html> 属性门控即时生效，无需重建 */
        state.cmdkW = t2.checked ? 1 : 0;
        persist();
        applyCmdkW();
        return;
      }
      if (t2.classList.contains("zu-tip-click")) {
        /* v249：纯渲染偏好，即时生效（下一次 mousemove/click 即按新模式判定） */
        state.tipClick = t2.checked ? 1 : 0;
        persist();
        return;
      }
      if (t2.name === "zu-lang") {
        if (t2.value !== state.lang) {
          /* v177：cnUnits() 依赖 state.lang，zh↔en 翻转 turn-text 的 cn 分量——与 cnNum/
           * forceKmb 同款在途竞态守卫，拒掉旧单位格式的在途回复 */
          richTextUnitEpoch++;
          richTextAttempts = {};
        }
        state.lang = t2.value;
        persist();
        buildPanel();   // 面板自身文案随语言重建（含 radio 勾选态）
        rebuildExcBubble();
        renderAll(true);   // 条面单位与 tooltip 文案随语言刷新（含各实例面板文案重建）
        gear.setAttribute("aria-label", L("打开状态条设置", "Open status bar settings"));
        var languageInput = panel.querySelector('input[name="zu-lang"][value="' + state.lang + '"]');
        if (languageInput && languageInput.focus) languageInput.focus();
        return;
      }
      if (t2.classList.contains("zu-ac-value")) {
        /* v179→v188：数值变化即提交（留空=跟随引擎默认；主进程归一白名单后写
           autocompact.json，引擎 hook 每轮决策读——下一轮即生效，无需重启） */
        sendAutoCompactConfig();
        return;
      }
      if (t2.type === "checkbox") {
        state.show[t2.dataset.k] = t2.checked ? 1 : 0;
        persist();
        if (t2.dataset.k === "git") refreshWants();   // v96：开/关即时更新上报路径集（开启时顺带触发首查）
        if (t2.dataset.k) autoCompactOnShow(t2.dataset.k, !!t2.checked);   // v226：六格全关自动转精简/重开恢复
      } else if (t2.classList.contains("zu-ctxov")) {
        state.ctxOv = t2.value.trim();
        persist();
      } else if (t2.classList.contains("zu-rst-cdh")) {
        var cdh = parseInt(t2.value.trim(), 10);
        state.resetCdh = cdh >= 1 && cdh <= 24 * 7 ? cdh : 24;   // 1–168 小时，非法回退默认 24
        persist();
        renderAll(false);   // 阈值即时生效：徽标倒计时随 heavy/render 对账刷新
      }
      renderAll(false);
    });
    listenGlobal(document, "mousedown", function (e) {
      /* v80：面板挂 body 后 bar.contains 不再覆盖面板自身，点面板内部不能关 */
      if (panel.classList.contains("open") && !bar.contains(e.target) && !panel.contains(e.target)) {
        closeSettings(false);
        previousPanelFocus = null;
      }
      if (subPopOpen() && !bar.contains(e.target) && !subPanel.contains(e.target)) subPopClose(false, "outside");
    });
    listenGlobal(document, "click", onProjRowClick);   // v137：编辑项目弹窗源文件夹行点击打开文件管理器（随实例 dispose 摘除）

    /* ---------- 子代理统一浮层（v217）：悬停预览/点击固定，双栏单一组件 ----------
     * 旧两层界面（悬停五段卡 tooltip + 点击弹出的独立明细面板）合并：同一入口、
     * 同一浮层、closed/preview/pinned 三态一套控制。外壳（标题栏/导航/底栏）与右栏
     * 内容按签名幂等重建，重建前后恢复左右滚动位置；选中任务按 sid 维护，任务从
     * 当前会话数据消失才回「汇总」。运行中尚未入库的槽位（subRate.slots）同样进
     * 导航（无记录项显示运行状态与估算速率）。会话切换即关闭，不跨会话沿用选择。 */
    var subPopSel = "";          // 选中任务 sid（""=汇总）
    var subPopMode = "closed";   // closed | preview | pinned
    var subPopEntry = null;      // 触发元素（.zu-sub 条目 / compact chip）
    var subPopHideTimer = 0;     // preview 离开后的延迟关闭
    var subPopSuppressAt = 0;    // 显式关闭后的本次悬停抑制（防立即重开）
    var subPopSig = "";          // 渲染签名（幂等：数据推送/切换不闪烁）
    var subPopSess = "";         // 打开时会话（pickedSid），变化即关
    function subPopOpen() { return subPopMode !== "closed"; }
    function subPopIco(paths, size) {
      /* 浮层挂 body 不在 .zusage-root 内，.ico 宽高样式不生效——显式尺寸 */
      return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    }
    function subPopItems(sub) {
      var list = (sub && sub.list) || [], out = [], seen = {}, i;
      for (i = 0; i < list.length; i++) {
        var s1 = list[i], sid = String(s1.sid || "");
        if (!sid || seen[sid]) continue;
        seen[sid] = 1;
        out.push({ sid: sid, rec: s1 });
      }
      var sids = [];
      for (var k in subRate.slots) sids.push(k);
      sids.sort();
      for (i = 0; i < sids.length; i++) if (!seen[sids[i]]) out.push({ sid: sids[i], rec: null });
      return out;
    }
    function subPopNameOf(it1) {
      if (!it1.rec) return L("子代理 …", "agent …") + it1.sid.slice(-4);
      return String(it1.rec.task || "").trim() || String(it1.rec.title || "").trim() ||
        String(it1.rec.agent || "sub").replace(/^zcode-/, "") + "…" + it1.sid.slice(-4);
    }
    function subPopRunningCount() {
      var n = 0, now = Date.now();
      for (var k in subRate.slots) {
        var sl = subRate.slots[k];
        if (sl && sl.rate != null && now - sl.at <= 3000) n++;
      }
      return n;
    }
    function subPopKpi(k, v, u) {
      return '<div class="zu-sp-kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
        (u ? '<div class="u">' + u + "</div>" : "") + "</div>";
    }
    function subPopKpis(a1, a2, a3, extraCls) {
      return '<div class="zu-sp-kpis3' + (extraCls ? " " + extraCls : "") + '">' + a1 + a2 + a3 + "</div>";
    }
    /* 模型用量四列表（汇总页/任务页共用）：逐模型费用尾随 ? 图标（data-model/data-rates
     * 随行携带单价，面板 fxq 委托弹说明），费开关关/无费用列显 — */
    function subPopModelsHTML(models) {
      if (!models || !models.length) return "";
      var rows = models.map(function (m1) {
        var mc = "—";
        if (state.cost && typeof m1.cost_usd === "number" && isFinite(m1.cost_usd)) {
          mc = ttEsc(fmtMoney(m1.cost_usd)) +
            FXQ_ICON.replace('class="tip-fxq"', 'class="tip-fxq" data-model="' + escAttr(m1.model || "") + '"' +
              (m1.rates ? ' data-rates="' + escAttr(JSON.stringify(m1.rates)) + '"' : ""));
        }
        return "<tr><td>" + ttEsc(m1.model || L("未知模型", "unknown")) + "</td><td>" + ttEsc(fmt(m1.total || 0)) +
          "</td><td>" + ttEsc(countFmt(m1.requests || 0)) + "</td><td>" + mc + "</td></tr>";
      }).join("");
      return '<div class="zu-sp-models"><h4>' + ttEsc(L("模型用量", "Model usage")) + "</h4><table><thead><tr>" +
        "<th>" + ttEsc(L("模型", "Model")) + "</th><th>" + ttEsc(L("Token 用量", "Tokens")) + "</th><th>" +
        ttEsc(L("请求", "Requests")) + "</th><th>" + ttEsc(L("预估费用", "Est. cost")) + "</th></tr></thead><tbody>" +
        rows + "</tbody></table></div>";
    }
    function subPopSummaryHTML(sub) {
      var run = subPopRunningCount();
      var costOk = !!(state.cost && sub && typeof sub.cost_usd === "number" && isFinite(sub.cost_usd));
      var sIn = (sub && sub.input) || 0, sHit = sIn > 0 ? Math.round(((sub && sub.cache_read) || 0) / sIn * 100) : -1;
      var sRea = (sub && sub.reasoning) || 0;
      var k1 = subPopKpi(ttEsc(L("总用量", "Total tokens")), ttEsc(fmt((sub && sub.total) || 0)), "");
      var k2 = subPopKpi(ttEsc(L("请求次数", "Requests")), ttEsc(countFmt((sub && sub.requests) || 0)), "");
      var k3 = subPopKpi(ttEsc(L("预估费用", "Est. cost")) + fxqIcon(sub && sub.models, L("子代理累计", "the sub-agents")), costOk ? ttEsc(fmtMoney(sub.cost_usd)) : "—", "");
      var u1 = subPopKpi(ttEsc(L("输入", "Input")), ttEsc(fmt(sIn)),
        sHit >= 0 ? '<span class="hit">' + ttEsc(L("缓存命中率 ", "cache hit ") + sHit + "%") + '</span>' : "");
      var u2 = subPopKpi(ttEsc(L("输出", "Output")), ttEsc(fmt((sub && sub.output) || 0)),
        sRea > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(sRea)) : "");
      var u3 = subPopKpi(ttEsc(L("缓存命中", "Cache read")), ttEsc(fmt((sub && sub.cache_read) || 0)), "");
      var band = sub && sub.rate_avg > 0 ? tpsBand(sub.rate_avg) : null;
      var rate = '<div class="zu-sp-rate">' + ttEsc(L("平均速率", "Average rate")) +
        (band ? '<b class="' + band.cls + '">' + ttEsc(sub.rate_avg.toFixed(1)) + "</b>" + ttEsc(L(" t/s", " t/s"))
              : "<b>—</b>") + "</div>";
      var models = subPopModelsHTML(sub && sub.models);
      return '<div class="zu-spview-head"><h3>' + ttEsc(L("汇总", "Summary")) + "</h3>" +
        '<span class="zu-spstate' + (run ? " run" : "") + '"><span class="dot"></span>' +
        ttEsc(run ? run + L(" 个子代理运行中", " sub-agent(s) running") : L("暂无运行中的子代理", "No running sub-agents")) +
        "</span></div>" +
        subPopKpis(k1, k2, k3) + subPopKpis(u1, u2, u3, "zu-sp-usage") + rate + models;
    }
    function subPopDetailHTML(it1) {
      var r = it1.rec || {}, name = subPopNameOf(it1);
      var sub2 = String(r.agent || "subagent").replace(/^zcode-/, "") + " · …" + it1.sid.slice(-4);
      var band = r.tps_avg > 0 ? tpsBand(r.tps_avg) : null;
      var rIn = r.input || 0, rHit = rIn > 0 ? Math.round((r.cache_read || 0) / rIn * 100) : -1;
      var k1 = subPopKpi(ttEsc(L("总消耗", "Total")), ttEsc(fmt(r.total || 0)), "");
      var k2 = subPopKpi(ttEsc(L("请求次数", "Requests")), ttEsc(countFmt(r.requests || 0)), "");
      var k3 = subPopKpi(ttEsc(L("平均速率", "Avg rate")),
        band ? '<span class="' + band.cls + '">' + ttEsc(r.tps_avg.toFixed(1)) + '</span><small>t/s</small>' : "—", "");
      var u1 = subPopKpi(ttEsc(L("输入", "Input")), ttEsc(fmt(rIn)),
        rHit >= 0 ? '<span class="hit">' + ttEsc(L("缓存命中率 ", "cache hit ") + rHit + "%") + '</span>' : "");
      var u2 = subPopKpi(ttEsc(L("输出", "Output")), ttEsc(fmt(r.output || 0)),
        r.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(r.reasoning)) : "");
      var u3 = subPopKpi(ttEsc(L("缓存命中", "Cache read")), ttEsc(fmt(r.cache_read || 0)),
        r.cache_write > 0 ? ttEsc(L("缓存写入 ", "cache write ") + fmt(r.cache_write)) : "");
      var meta = [];
      if (r.last) meta.push(L("最后活动", "Last active") + " <b>" + ttEsc(fmtStartS(r.last)) + "</b>");
      if (r.active || it1.rec === null) {
        /* 运行中：估算速率 span 由面板 800ms tick 原地刷新（.subrate[data-sid] 契约不变） */
        meta.push('<span class="subrate" data-sid="' + escAttr(it1.sid) + '">' + ttEsc(subRateSlotText(it1.sid)) + "</span>");
      }
      return '<div class="zu-spview-head"><h3 title="' + escAttr(name) + '">' + ttEsc(name) + "</h3>" +
        '<span class="zu-spsub">' + ttEsc(sub2) + "</span></div>" +
        subPopKpis(k1, k2, k3) + subPopKpis(u1, u2, u3, "zu-sp-usage") +
        subPopModelsHTML(r.models) +
        (meta.length ? '<div class="zu-sp-meta">' + meta.join("") + "</div>" : "");
    }
    function buildSubPop(sub) {
      var items = subPopItems(sub);
      if (subPopSel) {
        var keep = items.filter(function (x) { return x.sid === subPopSel; });
        if (!keep.length) subPopSel = "";   // 任务已从当前会话数据消失才回汇总
      }
      var runN = subPopRunningCount();
      var sig = subPopMode + "|" + subPopSel + "|" + items.map(function (x) { return x.sid; }).join(",") +
        "|" + runN + "|" + (state.cost ? 1 : 0) + "|" + JSON.stringify(sub || null);
      if (sig === subPopSig) return;
      subPopSig = sig;
      var oldNav = subPanel.querySelector(".zu-spnav-list"), oldBody = subPanel.querySelector(".zu-spbody");
      var navTop = oldNav ? oldNav.scrollTop : 0, bodyTop = oldBody ? oldBody.scrollTop : 0;
      var nav = '<button type="button" class="zu-spnav-item' + (subPopSel === "" ? " on" : "") + '" data-sid="" aria-selected="' + (subPopSel === "") + '"><span class="zu-spnav-label">' + ttEsc(L("汇总", "Summary")) + "</span></button>" +
        '<div class="zu-spnav-h">' + ttEsc(L("任务列表", "Tasks")) + '</div><div class="zu-spnav-list">';
      for (var i = 0; i < items.length; i++) {
        var on = items[i].sid === subPopSel;
        nav += '<button type="button" class="zu-spnav-item' + (on ? " on" : "") + '" data-sid="' + escAttr(items[i].sid) +
          '" aria-selected="' + on + '" title="' + escAttr(subPopNameOf(items[i])) + '"><span class="zu-spnav-label">' +
          ttEsc(subPopNameOf(items[i])) + "</span>" +
          (items[i].rec === null ? '<span class="zu-spnav-live" data-sid="' + escAttr(items[i].sid) + '">' + ttEsc(subRateSlotText(items[i].sid)) + "</span>" : "") +
          "</button>";
      }
      nav += "</div>";
      var body = subPopSel === "" ? subPopSummaryHTML(sub)
        : subPopDetailHTML(items.filter(function (x) { return x.sid === subPopSel; })[0]);
      subPanel.innerHTML =
        '<div class="zu-sph">' + subPopIco('<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="7.5" r="2.6"/><circle cx="8" cy="18" r="2.6"/><path d="M7.5 8.2 8 15.4M16.2 9.2 9.8 16.2M8.6 6.2l7 1"/>', 20) +
          '<span class="zu-sph-t">' + ttEsc(L("子代理", "Sub-agents")) + "</span>" +
          '<span class="zu-sph-scope">' + ttEsc(L("当前会话", "Current session")) + "</span>" +
          '<button type="button" class="zu-sph-x" aria-label="' + ttEsc(L("关闭", "Close")) + '">' +
            subPopIco('<path d="M18 6 6 18M6 6l12 12"/>', 15) + "</button></div>" +
        '<div class="zu-spb"><nav class="zu-spnav" aria-label="' + ttEsc(L("任务导航", "Task navigation")) + '">' + nav + "</nav>" +
          '<section class="zu-spbody">' + body + "</section></div>" +
        '<div class="zu-spf">' + subPopIco('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>', 14) +
          ttEsc(L("独立统计，不计入会话累计。", "Tracked separately, not counted in session total.")) + "</div>";
      var nN = subPanel.querySelector(".zu-spnav-list"), bN = subPanel.querySelector(".zu-spbody");
      if (nN) nN.scrollTop = navTop;   // 数据刷新保持左列表滚动位置
      if (bN) bN.scrollTop = bodyTop;
    }
    function positionSubPop() {
      if (!subPopOpen()) return;
      if (subPopEntry && !subPopEntry.isConnected) { subPopClose(false, "entry-gone"); return; }
      var width = subPanel.offsetWidth, height = subPanel.offsetHeight;
      var ir = subPopEntry ? subPopEntry.getBoundingClientRect() : bar.getBoundingClientRect();
      if (!ir.width && !ir.height) ir = bar.getBoundingClientRect();   // 隐藏条内入口 rect 全零，回退条锚
      var left = ir.left + ir.width / 2 - width / 2;
      left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
      var top = ir.top - height - 12;   // 优先入口上方，12px 安全缝
      if (top < 12) {
        top = ir.top + ir.height + 12;   // 上方不足翻下方
        if (top + height > window.innerHeight - 12) top = Math.max(12, window.innerHeight - height - 12);
      }
      subPanel.style.left = Math.round(left) + "px";
      subPanel.style.top = Math.round(top) + "px";
    }
    var subRateTimer = 0;
    function subRateTickPanel() {
      if (inactive() || !subPopOpen()) {
        if (subRateTimer) { clearInterval(subRateTimer); subRateTimer = 0; }
        return;
      }
      var spans = subPanel.querySelectorAll(".subrate");
      for (var i = 0; i < spans.length; i++) {
        var txt = subRateSlotText(spans[i].getAttribute("data-sid") || "");
        if (spans[i].textContent !== txt) spans[i].textContent = txt;
      }
    }
    /* 数据推送跟随（render 两路径共用）：会话切换即关（不跨会话沿用选择/数据）；
     * 默认模式条面重建后按同 pane 唯一 .zu-sub 重绑入口，随后签名幂等刷新内容 */
    function subPopFollowPush(view) {
      if (!subPopOpen()) return;
      if (pickedSid !== subPopSess) { subPopClose(false, "session-switch"); return; }
      if (subPopEntry && !subPopEntry.isConnected && state.theme !== "compact") {
        var nuE = main.querySelector(".zu-sub");
        if (nuE) subPopEntry = nuE;
      }
      buildSubPop(view.sub);
    }
    function subPopCancelHide() { if (subPopHideTimer) { clearTimeout(subPopHideTimer); subPopHideTimer = 0; } }
    function subPopScheduleHide() {
      if (subPopMode !== "preview" || subPopHideTimer) return;
      subPopHideTimer = setTimeout(function () { subPopHideTimer = 0; subPopClose(false, "preview-leave"); }, 260);
    }
    function subPopShow(entry, pinned) {
      if (inactive()) return;
      subPopCancelHide();
      subPopEntry = entry || subPopEntry;
      var wasClosed = subPopMode === "closed";
      if (wasClosed) { subPopSel = ""; subPopSess = pickedSid; }   // 每次新开默认汇总
      subPopMode = pinned ? "pinned" : (wasClosed ? "preview" : subPopMode);
      closeSettings(false);   // 与设置面板互斥
      hideTip(true, "sub-pop");   // 移向入口的路上可能触发过条目 tooltip
      subPanel.classList.toggle("zu-light", !themeDark);   // 主题即时同步（applyBarTheme 只在切换路径跑）
      subPanel.classList.add("open");
      buildSubPop(lastSub);
      positionSubPop();
      if (!subRateTimer) subRateTimer = setInterval(subRateTickPanel, 800);
      if (pinned) {
        var first = subPanel.querySelector('.zu-spnav-item[data-sid=""]');
        if (first && first.focus) first.focus();   // 键盘/点击固定：焦点进「汇总」导航项
      }
    }
    function subPopClose(restoreFocus, cause) {
      var trg = null;
      if (restoreFocus) {
        trg = state.theme === "compact" ? (tpsChipCache && tpsChipCache.isConnected ? tpsChipCache : null)
          : main.querySelector(".zu-sub");
      }
      if (subPopHideTimer) { clearTimeout(subPopHideTimer); subPopHideTimer = 0; }
      subPopMode = "closed";
      subPopEntry = null;
      subPopSel = "";
      subPopSig = "";
      subPanel.classList.remove("open");
      if (subRateTimer) { clearInterval(subRateTimer); subRateTimer = 0; }
      if (trg && trg.focus) trg.focus();   // Escape/关闭按钮：焦点归还实际入口（compact 归 chip）
      subPopSuppressAt = Date.now() + 500;   // 关闭后短暂抑制悬停重开（鼠标仍停留入口时不闪回）
    }
    subPanel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); subPopClose(true, "escape"); }
    });
    subPanel.addEventListener("focusin", function () {
      if (subPopMode === "preview") subPopMode = "pinned";   // 键盘 Tab 进浮层即固定（预览不抢焦点）
    });
    bar.addEventListener("click", function (e) {
      if (inactive()) return;
      if (e.target && e.target.closest && e.target.closest(".zu-sub")) {
        e.stopPropagation();
        /* 悬停后的第一次点击是固定当前浮层，不当成关闭；pinned 再点入口才关 */
        if (subPopMode === "pinned") subPopClose(true, "re-click");
        else subPopShow(e.target.closest(".zu-sub"), true);
        return;
      }
      /* v249 点击激活：只在开关开启时接管普通格子；关闭（缺省）沿用 mousemove 即时链。
       * 点开的 tooltip 复用既有「移入 tip 保持 / 移出条面收起 / Escape 收」逻辑，
       * 不另起 pin 状态机（键盘 focusin 仍即时打开，两种模式一致）。 */
      if (state.tipClick && e.target && e.target.closest) {
        var ci = e.target.closest(".it");
        if (ci && ci.__tip) {
          e.stopPropagation();
          mouseInBar = true;
          /* 鼠标点 span[tabindex=0] 会先 focusin 即时打开（键盘无障碍要求），click 紧随其后；
           * 此刻不可按「再点关闭」处理，否则首击点不开。仅 focusin 之外的再点才关闭。 */
          if (ci !== tipFor) showTipFor(ci);
          else if (Date.now() - focusTipAt > 300) hideTip(true, "re-click");
        }
      }
    });
    subPanel.addEventListener("click", function (e) {
      if (inactive()) return;
      if (e.target && e.target.closest && e.target.closest(".zu-sph-x")) {
        e.stopPropagation();
        subPopClose(true, "close-btn");
        return;
      }
      if (subPopMode === "preview") subPopMode = "pinned";   // 面板内任意点击即固定
      var b = e.target && e.target.closest ? e.target.closest(".zu-spnav-item") : null;
      if (!b) return;
      var next = b.getAttribute("data-sid") || "";
      if (next !== subPopSel) { subPopSel = next; buildSubPop(lastSub); }   // 原位切右栏，外壳不动
    });

    /* ---------- 输入框查找（穿透 open shadow / 同源 iframe） ---------- */
    var COMPOSER_SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
    var deepCache = { el: null, at: 0 };
    function visible(el) {
      var r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < innerHeight;
    }
    function deepFind() {
      if (deepCache.el && deepCache.el.isConnected && reallyVisible(deepCache.el)) return deepCache.el;
      if (Date.now() - deepCache.at < 1000) return null;
      deepCache.at = Date.now();
      var found = null;
      function scan(doc, depth) {
        if (found || !doc || depth > 8) return;
        try {
          doc.querySelectorAll(COMPOSER_SEL).forEach(function (el) {
            if (el.closest && el.closest('[role="dialog"]')) return;   // v62：弹窗内的编辑框不是聊天输入框（issue #9）
            if (inSettingsView(el)) return;   // 设置页（MCP 配置等）的编辑框不是聊天输入框
            if (!found && visible(el) && el.getBoundingClientRect().top > innerHeight * 0.45) found = el;
            else if (found && el.getBoundingClientRect().top > found.getBoundingClientRect().top && visible(el)) found = el;
          });
        } catch (e) { }
        if (found) return;
        try {
          doc.querySelectorAll("*").forEach(function (el) {
            if (!found && el.shadowRoot) scan(el.shadowRoot, depth + 1);
          });
        } catch (e) { }
        try {
          doc.querySelectorAll("iframe").forEach(function (fr) {
            if (!found) { try { if (fr.contentDocument) scan(fr.contentDocument, depth + 1); } catch (e) { } }
          });
        } catch (e) { }
      }
      scan(document, 0);
      if (found) deepCache.el = found;
      return found;
    }
    /* 输入框是否真的露在屏幕上：幽灵子树检测（设置页等 opacity-0/inert 壳，v61）+
     * 中心点命中测试（真渲染出来的覆盖层，如全屏对话框背景、悬浮菜单）。 */
    /* 自己的浮层（设置面板/超限气泡/悬停 tooltip）展开在条上方、必然覆盖输入区中心：
     * 若算进遮挡判定，会进 隐藏→复显→再隐藏 的循环（v40 离线复现的"打开设置闪烁"根因；
     * v41 补 tooltip——会话/工具的长 tooltip 同样盖住输入框中心，悬停 0.4s 后闪一下且 tooltip 消失）。
     * 只豁免 track 的可见性路径；findComposer 找输入框时不用（ownOK 缺省 false）。 */
    function isOwnOverlay(el) {
      try { return !!(el && el.closest && el.closest(".zusage-tip-root,.panel,.zusage-exc")); } catch (e) { return false; }
    }
    /* 幽灵子树检测（v61，取代 v58/v59 的 coverLock + 穿透特判）：
     * 客户端 3.11.x 的设置页 = 设置 tab 激活时给工作区主视图套 opacity-0 + inert +
     * pointer-events-none 的壳（DOM 与几何原样保留，纯视觉隐藏）。输入框落在这类
     * "保持挂载但视觉已隐藏"的祖先链里就判不可见 —— 直接读计算样式，与
     * elementFromPoint 无关，天然免疫滚动锁定期的穿透假象。 */
    function inGhostSubtree(el) {
      try {
        for (var p = el; p && p !== document.body; p = p.parentElement) {
          if (p.inert) return true;
          var cs = getComputedStyle(p);
          if (cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return true;
        }
      } catch (e) { }
      return false;
    }
    /* 判定缓存（v115）：track 每帧沿输入框祖先链逐个 getComputedStyle（幽灵判定），模态
     * 判定逐帧 querySelector + 遍历 body 子层，命中测试逐帧 elementFromPoint——60fps 下
     * 稳定产生每秒数十次强制样式查询，是悬浮条常驻 CPU 的最大来源。幽灵/遮挡/模态只随
     * 布局与弹层开关变化，条本身有 400ms 隐藏迟滞兜底，120~150ms 的判定陈旧肉眼不可感；
     * 用纯 TTL 缓存而不是 MutationObserver 脏标——流式输出每帧都在改 DOM，脏标会被
     * 反复置位而失效。命中结果绑定「元素矩形 + 模式」：矩形一变立即重算。 */
    var GHOST_TTL = 120, COVER_TTL = 150;
    var ghostCache = new WeakMap();   // el -> { val, at }
    var coverCache = new WeakMap();   // el -> { key, rect, val, at }（reallyVisible/coverOK 共用，key 区分模式）
    function ghostOf(el) {
      if (!el) return false;
      var now = Date.now(), hit = ghostCache.get(el);
      if (hit && now - hit.at < GHOST_TTL) return hit.val;
      var val = inGhostSubtree(el);
      ghostCache.set(el, { val: val, at: now });
      return val;
    }
    /* 模态弹窗打开判定（v62，issue #9）：Radix Dialog 往 body 挂一层「固定全屏 + 带底色 +
     * z-index 抬升」的遮罩（下拉菜单/选择器只设 body pointer-events:none、不挂遮罩——v61
     * 实测），且文档里同时存在 [role="dialog"]。此时聊天区整体不可交互，条必须整体收起：
     * 模型配置弹窗里的「推理参数映射」编辑框正好落在视口下半部，会被 findComposer 的
     * 启发式当聊天输入框，条就冒在弹窗里（用户 issue #9 截图）。
     * 自己的浮层（.zu-bar/.zu-back/.zu-sheet——移动端抽屉遮罩是同款全屏底色）不算。 */
    function modalOpen() {
      try {
        var dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"]');
        var hasVisibleDialog = false;
        for (var d = 0; d < dialogs.length; d++) {
          if (dialogs[d].classList && dialogs[d].classList.contains("zusage-panel")) continue;
          var ds = getComputedStyle(dialogs[d]);
          if (ds.display !== "none" && ds.visibility !== "hidden" && parseFloat(ds.opacity || "1") >= 0.05) {
            hasVisibleDialog = true;
            break;
          }
        }
        if (!hasVisibleDialog) return false;
        var kids = document.body.children;
        for (var i = 0; i < kids.length; i++) {
          var el = kids[i];
          var cls = String(el.getAttribute && el.getAttribute("class") || "");
          if (el.id === "zusage-bar" || /(^|\s)zu-(bar|back|sheet)(\s|$)/.test(cls) || (el.classList && el.classList.contains("zusage-panel"))) continue;
          var cs = getComputedStyle(el);
          if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
          if (parseFloat(cs.opacity || "1") < 0.05) continue;
          if (!(parseInt(cs.zIndex, 10) >= 10)) continue;   // 遮罩必抬层（z-40/50）；普通全屏容器不抬
          var r = el.getBoundingClientRect();
          if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) continue;
          var bg = cs.backgroundColor;
          if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") continue;
          return true;
        }
      } catch (e) { }
      return false;
    }
    /* v115：modalOpen 每次调用先 querySelector、有弹窗时再逐 body 子层 getComputedStyle；
     * track 逐帧调用是纯浪费。弹层开关远慢于 150ms，TTL 缓存后逐帧零开销。
     * diagHidden 用原版 modalOpen（诊断要现场真值，不吃缓存）。 */
    var MODAL_TTL = 150, modalAt = 0, modalVal = false;
    function modalOpenCached() {
      var now = Date.now();
      if (now - modalAt < MODAL_TTL) return modalVal;
      modalAt = now;
      modalVal = modalOpen();
      return modalVal;
    }
    function reallyVisible(el, ownOK) {
      if (!visible(el)) return false;
      if (ghostOf(el)) return false;   // 设置页等幽灵壳：视觉已隐藏（v61，v115 TTL 缓存）
      var r = el.getBoundingClientRect();
      var key = ownOK ? "o" : "n";
      var rectKey = r.left + "," + r.top + "," + r.width + "," + r.height;
      var now = Date.now(), ch = coverCache.get(el);
      if (ch && ch.key === key && ch.rect === rectKey && now - ch.at < COVER_TTL) return ch.val;
      var val = hitSelf(el, r, ownOK);
      coverCache.set(el, { key: key, rect: rectKey, val: val, at: now });
      return val;
    }
    function hitSelf(el, r, ownOK) {
      var hit;
      try { hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) { return true; }
      if (!hit) return false;
      /* 命中根元素 = 穿透（v61 翻转判定）：Radix 模态层（下拉/对话框/modal 弹层）打开时给
       * body 设 pointer-events:none，应用树全被跳过、elementFromPoint 一路穿到 <html>。
       * v58/v59 曾把它当"被盖"（修设置页冒条），但正常聊天里开任何下拉也会中招——
       * 条被误藏（用户实测）。现改判"可见"：设置页场景由 inGhostSubtree 兜住
       * （3.11.x 设置壳必带 opacity-0+inert，不依赖命中测试），其余穿透场景
       * 都是真·未被盖（弹层在别处，输入框露着）。 */
      if (hit === document.body || hit === document.documentElement) return true;
      if (hit === el || hit.contains(el) || el.contains(hit)) return true;   // 命中自身/祖先/内部装饰层
      /* 悬浮气泡豁免（v65）：非模态浮层（「剩余额度」hover 卡、下拉/选择器弹层——body
       * 直挂、无遮罩）会压住输入框中心点，按旧判定悬停一超 400ms 迟滞整条就消失
       * （用户实测）。但条挂在输入框正下方，上方浮层与条并无几何冲突：命中元素只是
       * 部分遮挡（未把输入框矩形整体罩住）时仍判可见。整体罩住才维持"被盖"——模态
       * 全屏遮罩等真接管行为不变，模态弹窗/设置页另有 modalOpen/inGhostSubtree 收口。 */
      var hr = hit.getBoundingClientRect();
      if (hr.left > r.left || hr.top > r.top || hr.right < r.right || hr.bottom < r.bottom) return true;
      if (ownOK && isOwnOverlay(hit)) return true;
      return false;
    }
    function findComposer() {
      var best = null;
      document.querySelectorAll("textarea").forEach(function (ta) {
        if (ta.closest && ta.closest('[role="dialog"]')) return;   // v62：弹窗内的编辑框不是聊天输入框（模型配置弹窗的「推理参数映射」落在下半屏，issue #9）
        if (inSettingsView(ta)) return;   // 设置页（MCP 配置等）的编辑框不是聊天输入框
        if (!reallyVisible(ta)) return;
        var r = ta.getBoundingClientRect();
        if (r.top < innerHeight * 0.45) return;   // 聊天输入框特征：在视口下半部（排除设置页等处元素）
        if (!best || r.top > best.getBoundingClientRect().top) best = ta;
      });
      return best || deepFind();
    }
    function collectDiag(extra) {
      if (everMounted) return;  /* 已成功挂载的窗口才允许写诊断，防后台空窗口覆盖 */
      if (Date.now() - (collectDiag.at || 0) < 5000) { if (extra) Object.assign(window.__zusageDiag, extra); return; }
      collectDiag.at = Date.now();
      /* 只在 window.__zusageDiag 本体上原地更新，绝不整体替换对象：
       * v14 曾用 Object.assign(d, ...) 换新对象，FATAL 仍指旧对象，
       * 之后写入的 mount/trackErr 全进孤儿对象，diag 文件永远看不到（实测翻车）。 */
      var d = window.__zusageDiag;
      d.time = new Date().toISOString();
      d.version = VERSION;
      d.href = String(location.href).slice(0, 90);
      var shallow = {};
      COMPOSER_SEL.split(",").forEach(function (sel) {
        try { shallow[sel.trim()] = document.querySelectorAll(sel).length; } catch (e) { }
      });
      d.shallow = shallow;
      d.iframes = document.querySelectorAll("iframe").length;
      var sr = 0;
      (function walk(doc) {
        if (!doc || !doc.querySelectorAll) return;
        var all;
        try { all = doc.querySelectorAll("*"); } catch (e) { return; }
        for (var i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) { sr++; walk(all[i].shadowRoot); }
        }
      })(document);
      d.shadowRoots = sr;
      if (extra) Object.assign(d, extra);
    }

    /* 每实例只归还自己占用的卡片，不能清掉其它 pane 的让位边距。 */
    var paddedCard = null, originalMargin = "", originalMarginPriority = "", pillLayoutAnchor = null, pillMarginFloor = 0, lastPillMargin = "", lastPillHeight = 0, lastPillGeometry = "";
    var pillMoveCheck = null, pillUnmovable = false, pillUnsafe = false, pillBottomLimit = null;
    function releasePads() {
      if (!paddedCard) return;
      if (!lastPillMargin || paddedCard.style.marginBottom === lastPillMargin) {
        if (originalMarginPriority && paddedCard.style.setProperty) paddedCard.style.setProperty("margin-bottom", originalMargin, originalMarginPriority);
        else paddedCard.style.marginBottom = originalMargin;
      }
      delete paddedCard.dataset.zuCardPad;
      paddedCard = null;
      pillMarginFloor = 0;
      lastPillMargin = "";
      lastPillHeight = 0;
      lastPillGeometry = "";
      pillMoveCheck = null;
      pillUnmovable = false;
      pillUnsafe = false;
      pillBottomLimit = null;
    }
    function pillMarginTarget() {
      if (!pillSurface) return cardCache;
      try { return pillSurface.closest('.chat-composer-input-surface') || pillSurface; } catch (e) { return pillSurface; }
    }
    function adjustPillBottom() {
      if (state.theme !== "pill" || !paddedCard || !pillSurface || !bar.offsetHeight) return;
      var dock = null;
      try { dock = paddedCard.closest('[data-v4-composer-dock-content="true"]'); } catch (e) { }
      var anchorRect = (pillLayoutAnchor || pillSurface).getBoundingClientRect();
      var dockRect = dock ? dock.getBoundingClientRect() : (paddedCard.parentElement && paddedCard.parentElement.getBoundingClientRect());
      if (!dockRect) return;
      var sizeKey = innerWidth + ":" + innerHeight + ":" + Math.round(dockRect.width || 0) + ":" + bar.offsetHeight;
      try { if (dock) sizeKey += ":" + getComputedStyle(dock).paddingBottom; } catch (e) { }
      if (sizeKey !== lastPillGeometry) {
        lastPillGeometry = sizeKey;
        pillMoveCheck = null;
        pillUnmovable = false;
        pillUnsafe = false;
        lastPillMargin = Math.max(pillMarginFloor, bar.offsetHeight) + "px";
        paddedCard.style.marginBottom = lastPillMargin;
        anchorRect = (pillLayoutAnchor || pillSurface).getBoundingClientRect();
      }
      var pane = null;
      try { pane = composer.closest('[data-testid^="v4-pane-shell-"]'); } catch (e) { }
      var paneRect = pane && pane.getBoundingClientRect();
      var bottom = paneRect ? Math.min(innerHeight, paneRect.bottom) : innerHeight;
      pillBottomLimit = bottom;
      var dockHeight = dockRect.height || Math.max(0, dockRect.bottom - dockRect.top);
      var nearBottom = dockHeight > 0 && Math.abs(bottom - dockRect.bottom) <= dockHeight / 2;
      var goal = bottom - bar.offsetHeight - 16;
      if (pillMoveCheck) {
        if (pillMoveCheck.bottom - anchorRect.bottom < 1) pillUnmovable = true;
        pillMoveCheck = null;
      }
      pillUnsafe = anchorRect.bottom > goal + 1;
      if (!nearBottom || pillUnmovable) return;
      var current = parseFloat(paddedCard.style.marginBottom) || 0;
      var delta = anchorRect.bottom - goal;
      if (delta <= 1) return;
      var next = Math.max(pillMarginFloor, Math.ceil(current + delta));
      if (Math.abs(next - current) <= 1) return;
      pillMoveCheck = { bottom: anchorRect.bottom };
      lastPillMargin = next + "px";
      paddedCard.style.marginBottom = lastPillMargin;
    }
    var CARD_MARGIN = "24px";
    function ensureCardPad() {
      var target = state.theme === "pill" && pillSurface ? pillMarginTarget() : cardCache;
      if (!target) return;
      if (paddedCard !== target) {
        releasePads();
        paddedCard = target;
        originalMargin = target.style.marginBottom || "";
        originalMarginPriority = target.style.getPropertyPriority ? target.style.getPropertyPriority("margin-bottom") : "";
        try { pillMarginFloor = Math.max(0, parseFloat(getComputedStyle(target).marginBottom) || 0); } catch (e) { pillMarginFloor = 0; }
        target.dataset.zuCardPad = originalMargin;
      }
      if (state.theme !== "pill") {
        if (target.style.marginBottom !== CARD_MARGIN) target.style.marginBottom = CARD_MARGIN;
        lastPillMargin = CARD_MARGIN;
        return;
      }
      var height = bar.offsetHeight || 0;
      if (!height) return;
      if (lastPillMargin && target.style.marginBottom !== lastPillMargin) {
        originalMargin = target.style.marginBottom || "";
        originalMarginPriority = target.style.getPropertyPriority ? target.style.getPropertyPriority("margin-bottom") : "";
        try { pillMarginFloor = Math.max(0, parseFloat(getComputedStyle(target).marginBottom) || 0); } catch (e) { pillMarginFloor = 0; }
        target.dataset.zuCardPad = originalMargin;
        lastPillMargin = "";
      }
      if (!lastPillMargin || lastPillHeight !== height) {
        lastPillMargin = Math.max(pillMarginFloor, Math.ceil(height)) + "px";
        lastPillHeight = height;
        target.style.marginBottom = lastPillMargin;
      }
    }

    /* 从 textarea 向上找视觉卡片容器（有可见边框或背景的最近祖先）——条的锚点 + 读原生总量按钮 */
    function isVisualBox(el) {
      try {
        var cs = getComputedStyle(el);
        return cs.borderTopWidth !== "0px" || cs.backgroundColor !== "rgba(0, 0, 0, 0)";
      } catch (e) { return false; }
    }
    function cardOf(el) {
      var cr = el.getBoundingClientRect();
      var p = el.parentElement, last = el, i = 0;
      for (; p && p !== document.body && i < 8; p = p.parentElement, i++) {
        var r = p.getBoundingClientRect();
        if (r.height > cr.height * 8 + 80) break;          // 会话级大容器（高度异常）
        if (isVisualBox(p)) return p;                       // 第一个有边框/背景的层 = 视觉卡片
        last = p;
      }
      return last;
    }
    /* 权限确认面板内的锚点改判：composer 被面板顶掉（display:none）后，面板里的
     * 反馈输入框是该 pane 唯一候选——它比面板卡矮得多，cardOf 的高度熔断会在到达面板卡
     * 之前 break，落到面板内部的选项/反馈包裹层，条就冒进面板里（最初的 bug：确认时条
     * 跑进对话框）。输入框带 data-permission-* 标记（或卡片自带的数据标记）时改判面板
     * 视觉卡：第一个「有边框且有背景」的祖先（选项按钮只有背景无边框会跳过，rounded-2xl
     * 面板卡二者俱全）。
     * 普通输入框不走这条（closest 不命中），行为与 v62 完全一致。 */
    function isCardLike(el) {
      try {
        var cs = getComputedStyle(el);
        return cs.borderTopWidth !== "0px" && cs.backgroundColor !== "rgba(0, 0, 0, 0)";
      } catch (e) { return false; }
    }
    function panelCardOf(el) {
      try {
        /* 权限面板与批准框（elicitation）同组件，卡片自带该标记（rounded-2xl 视觉卡），
         * 直接锚卡片——选项行聚焦/填写时带底色也会被 cardOf 误判成视觉盒，锚了它条会落进卡片里 */
        var card = el.closest("[data-elicitation-dialog-card]");
        if (card) return card;
        if (!el.closest('[data-permission-option-kind],[data-permission-feedback-option],[data-permission-rule-scopes]')) return null;
      } catch (e) { return null; }
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (isCardLike(p)) return p;
      }
      return null;
    }
    function anchorCardOf(el) {
      return panelCardOf(el) || cardOf(el);
    }
    function composerCardOf(el) {
      try {
        if (el && el.getAttribute && el.getAttribute("data-testid") === "v4-composer-input") {
          var shell = el.closest('.chat-composer-input-surface');
          var layout = el.closest('[data-composer-layout]');
          if (shell && layout && shell.contains(layout)) return layout;
        }
      } catch (e) { }
      return anchorCardOf(el);
    }
    /* 读原生 UI 的上下文总量（输入框工具行按钮的文本/aria-label，如"…总量 1,000,000"）。
     * 服务端下发、自动跟随模型，优先级高于 catalog 查表和 config fallback。 */
    var nativeCtx = { val: 0, at: 0 };
    function readNativeCtx(card) {
      if (Date.now() - nativeCtx.at < 5000) return nativeCtx.val;
      nativeCtx.at = Date.now();
      var els = card.querySelectorAll("button, [aria-label], [title]");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var t = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "";
        var m = t.match(/总量\s*([\d,，]+)/);
        if (m) {
          nativeCtx.val = parseInt(m[1].replace(/[,,]/g, ""), 10);
          return nativeCtx.val;
        }
      }
      return nativeCtx.val;
    }
    /* 解析原生上下文按钮 aria-label 的已用/总量（zh「上下文已用 X / 总量 Y」/ en "Context usage
     * X of Y"，chat.contextUsage；数字是普通千分位格式，面板摘要才是 compact 万/K 格式，不同源）。
     * 数据出自宿主 taskUsage store——与悬停面板同源，压缩后立即回落，比 DB 最近完成请求
     * 新鲜（issue #172）。解析不出（无数据回退标签等）返回 null。 */
    function parseNativeCtxLabel(label) {
      var t = String(label || "");
      var m = t.match(/已用\s*([\d,，]+)\s*\/\s*总量\s*([\d,，]+)/) ||
              t.match(/usage\s*([\d,，]+)\s*of\s*([\d,，]+)/i);
      if (!m) return null;
      /* 剥离类与匹配类同含全角逗号：match 认了 strip 不认会静默截断成错值（review 2026-10-31） */
      var used = parseFloat(m[1].replace(/[,，]/g, "")), total = parseFloat(m[2].replace(/[,，]/g, ""));
      if (!isFinite(used) || !isFinite(total) || used < 0 || total <= 0) return null;
      return { used: used, total: total, pct: Math.min(Math.max(used / total, 0), 1) * 100 };
    }

    /* ---------- v92 原生上下文按钮增强（v93 起档位口径唯一承载处）：环填充与右侧百分比 ----------
     * 按钮（chat-context-usage-trigger）与本条同 pane 同会话：数据优先镜像原生 aria-label
     * （宿主 taskUsage store，压缩后立即更新，issue #172），解析不出时回退本实例 lastBand
     * （DB 最近完成请求口径，ctxOv/nativeCtxVal 的 cw 优先级只作用于此兜底路径）。
     * 稳定性依据：React 不清理非 props 的手动 data-* 属性，也不动 wrapper 末尾追加的
     * 节点（其 React children 只有 button）；dasharray/dashoffset 属 React 管理，宿主
     * 数据更新瞬间会重写，由 render + heavy 双 reapply 兜回（≤600ms）。
     * 两源都无数据时还原原生形态（按钮仍承载 Coding Plan/Start Plan 面板，不动其存在性）。 */
    var ZU_CTX_TRIGGER = '[data-testid="chat-context-usage-trigger"]';
    var ZU_CTX_CIRC = 62.83185307179586;   // 原生环 r=10 的周长（还原原生 dashoffset 用）
    function enhanceCtxButton() {
      if (inactive()) return;
      var btn = null;
      try { btn = cardCache ? cardCache.querySelector(ZU_CTX_TRIGGER) : null; } catch (e) { }
      /* v156 增强开关关闭：还原原生环/百分比（restoreCtxButton 顺带清徽标，随后重挂），
       * 重置卡徽标仅借按钮做定位锚点，独立于增强继续维护 */
      if (!state.ctxEnh) {
        if (ctxBtnCache) { restoreCtxButton(ctxBtnCache); ctxBtnCache = null; }
        if (btn && btn.parentElement) syncResetBadge(btn);
        return;
      }
      var nat = null;
      try { nat = parseNativeCtxLabel(btn && btn.getAttribute("aria-label")); } catch (e) { }
      if (!btn || !btn.parentElement || (!nat && (!lastBand || !lastBand.cw))) {
        if (ctxBtnCache) { restoreCtxButton(ctxBtnCache); ctxBtnCache = null; }
        return;
      }
      /* 原生可解析时以原生占比显示（分档同表重算，exc 过程态仍优先）；lastBand 继续按 DB
       * 口径供给 acWarningText 等消费方，不在此改写。 */
      var band = lastBand;
      if (nat) band = {
        cw: nat.total, pct: nat.pct,
        exc: !!(lastBand && lastBand.exc),
        cls: lastBand && lastBand.exc ? "exc" : bandOf(CTX_BANDS, nat.pct),
      };
      ctxBtnCache = btn;
      if (btn.getAttribute("data-zusage-armed") !== "1") btn.setAttribute("data-zusage-armed", "1");
      if (btn.getAttribute("data-zusage-band") !== band.cls) btn.setAttribute("data-zusage-band", band.cls);
      var lite = bar.classList.contains("zu-light");
      syncCtxLite(btn, lite);
      var svg = null;   // 排除 .animate-spin：额度重置中 spinner 保留原生转圈，期间环回原生样式
      for (var i = 0; i < btn.children.length; i++) {
        var k = btn.children[i];
        if (String(k.tagName || "").toLowerCase() === "svg" && !(k.classList && k.classList.contains("animate-spin"))) { svg = k; break; }
      }
      if (svg) {
        var cs = svg.querySelectorAll("circle");
        var v = cs.length >= 2 ? cs[1] : null;
        if (v) {
          var da = Math.max(0, Math.min(100, band.pct)).toFixed(1) + " 100";
          if (v.getAttribute("pathLength") !== "100") v.setAttribute("pathLength", "100");
          if (v.getAttribute("stroke-dasharray") !== da) v.setAttribute("stroke-dasharray", da);
          if (v.getAttribute("stroke-dashoffset") !== "0") v.setAttribute("stroke-dashoffset", "0");
          if (v.getAttribute("stroke-linecap") !== "round") v.setAttribute("stroke-linecap", "round");
        }
      }
      var pctEl = null;
      for (var j = 0; j < btn.children.length; j++) {
        if (btn.children[j].classList && btn.children[j].classList.contains("zu-ctxpct")) { pctEl = btn.children[j]; break; }
      }
      if (!pctEl) {
        pctEl = document.createElement("span");
        pctEl.className = "zu-ctxpct";
        btn.appendChild(pctEl);   // 挂在 trigger 按钮内：悬停数值=悬停按钮，原生 hover 效果与「上下文容量」面板自动生效
      } else if (pctEl !== btn.children[btn.children.length - 1]) {
        btn.appendChild(pctEl);   // React 提交（如额度重置 loading 切换的 appendChild）可能把手动节点挤离末尾，挪回环右侧
      }
      var txt = band.pct.toFixed(1) + "%";
      var pcls = "zu-ctxpct pct " + band.cls;
      if (pctEl.textContent !== txt) pctEl.textContent = txt;
      if (pctEl.className !== pcls) pctEl.className = pcls;
      syncResetBadge(btn);
    }
    /* ---------- v135 重置卡徽标（.zu-ctxrst，工具行内额度组左侧） ----------
     * 数据：快照 quota.resets（独立 reset 链，账号族级，与额度 chip 开关无关）。
     * 内容：单族「重置 · N」，多族各账号张数 + 连接（重置 · 2+3）；剩余 < 阈值
     * （state.resetCdh 小时，默认 24）追加倒计时（取全局最早到期卡）。三档色按剩余时间：
     * >3h 绿 / 3h–30min 黄 / <30min 红+呼吸。挂载点随用户规格两次迁移：按钮内 → wrapper 内
     * 按钮右侧 → 工具行内、wrapper（额度 chip+上下文按钮组）左侧（2026-10-28 定稿）。
     * 工具行插入与 Git chip 同属 React 兄弟区（外来节点不复用不清理），位置由双 reapply 兜回；
     * 卡到期但数据未刷新（expireAt<=now）按无卡处理，绝不显示过期倒计时。 */
    function resetBadgeView() {
      if (!state.resetBadge || !lastResets) return null;
      /* 只信本 pane 的实时个人编码套餐选择；旧宿主无 marker 时不借历史请求或全局回退，
       * apiKey、团队与 Start Plan 也不能证明对应个人重置卡的归属。 */
      var provider = quotaSelection && quotaSelection.providerId;
      if (provider !== "account:bigmodel-individual-coding-plan" &&
          provider !== "account:zai-individual-coding-plan") return null;
      var now = Date.now(), earliest = 0, total = 0, fams = [], counts = [];
      ["bigmodel", "zai"].forEach(function (name) {
        var e = lastResets[name], count = 0;
        if (!e || typeof e !== "object") return;
        [e.fiveHour, e.week].forEach(function (cards) {
          if (!Array.isArray(cards)) return;
          cards.forEach(function (card) {
            var t = card && card.expireAt;
            if (typeof t !== "number" || !isFinite(t) || t <= now) return;
            count++;
            if (!earliest || t < earliest) earliest = t;
          });
        });
        if (count) { total += count; counts.push(String(count)); fams.push({ fam: name, entry: e }); }
      });
      if (!total) return null;
      var rem = earliest - now;
      var band = "zu-rst-calm";
      for (var bi = 0; bi < RST_BANDS.length; bi++) {
        if (rem <= RST_BANDS[bi].max) { band = RST_BANDS[bi].cls; break; }
      }
      var countdown = "";
      var cdh = state.resetCdh >= 1 ? state.resetCdh : 24;
      if (rem < cdh * 3600 * 1000) countdown = " · " + rstSpanText(rem);
      return { fams: fams, text: counts.join("+"), countdown: countdown,
        band: band, earliest: earliest, total: total };
    }
    function rstSpanText(rem) {   // 时分秒全档恒显（用户规格 2026-10-28：精确到秒、实时逐秒跳动）；中文紧邻、英文数字单位紧邻+时段间空格
      var segGap = L("", " ");
      var uh = L("时", "h"), um = L("分", "m"), us = L("秒", "s");
      var total = Math.max(0, Math.floor(rem / 1000));
      var hours = Math.floor(total / 3600), mins = Math.floor(total / 60) % 60, secs = total % 60;
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      if (state.lang === "en") {
        return [hours + uh, pad(mins) + um, pad(secs) + us].join(segGap);
      }
      return hours + uh + pad(mins) + um + pad(secs) + us;
    }
    function syncResetBadge(btn) {
      var wrap = btn.parentElement;
      if (!wrap || !wrap.parentElement) return;
      var host = wrap.parentElement;   // 工具行（group/toolbar）：与 Git chip 同级的 React 兄弟插入区
      var el = null;
      for (var i = 0; i < host.children.length; i++) {
        if (host.children[i].classList && host.children[i].classList.contains("zu-ctxrst")) { el = host.children[i]; break; }
      }
      var v = resetBadgeView();
      if (!v) {
        if (el) { if (rstTipFor === el) hideRstTip(); el.remove(); }
        return;
      }
      if (!el) {
        el = document.createElement("span");
        el.className = "zu-ctxrst";
        el.tabIndex = 0;
        el.addEventListener("keydown", function (e) { if (e.key === "Escape") hideRstTip(); });   // v118 键盘可达契约
        el.addEventListener("mouseenter", function () { cancelRstHide(); showRstTip(this); });
        el.addEventListener("mouseleave", scheduleRstHide);   // 延迟收起：给指针移入 tooltip 点「如何重置」留窗口
        el.addEventListener("focus", function () { showRstTip(this); });
        el.addEventListener("blur", hideRstTip);
        host.appendChild(el);
      }
      if (el.nextSibling !== wrap) host.insertBefore(el, wrap);   // 位置兜回：额度组（wrapper）左侧
      var txt = v.text + v.countdown;
      /* lucide refresh-cw：双箭头环形 = 通用「重置」视觉语言；此前卡内嵌箭头的复合图标
       * 在 14px 下墨迹过密显糊（用户反馈 2026-10-28） */
      var html = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>' + txt;   // 图标↔数字间距走 .zu-ctxrst>svg margin（字面空格在 flex 里渲染不稳定）
      if (el.__zuSig !== html) { el.innerHTML = html; el.__zuSig = html; }
      el.setAttribute("aria-label", L("额度重置卡 ", "Quota reset cards ") + txt);
      var cls = "zu-ctxrst " + v.band + (v.countdown ? " zu-rst-cd" : "");
      if (el.className !== cls) el.className = cls;
      el.__zuR = v;
      if (rstTipFor === el) showRstTip(el);   // 悬停时随数据及到期状态刷新；内容签名不变不重建
    }
    function syncCtxLite(el, lite) {
      var has = el.getAttribute && el.getAttribute("data-zusage-light");
      if (lite && !has) el.setAttribute("data-zusage-light", "1");
      else if (!lite && has) el.removeAttribute("data-zusage-light");
    }
    function restoreCtxButton(btn) {
      if (!btn || !btn.isConnected) return;
      btn.removeAttribute("data-zusage-armed");
      btn.removeAttribute("data-zusage-band");
      btn.removeAttribute("data-zusage-light");
      for (var i = 0; i < btn.children.length; i++) {
        if (btn.children[i].classList && btn.children[i].classList.contains("zu-ctxpct")) { btn.children[i].remove(); break; }
      }
      /* 重置徽标可能随历史版本留在 wrapper 内或工具行（挂载点迁移过），两处都清 */
      for (var scope = 0; scope < 2; scope++) {
        var rstHost = scope === 0 ? btn.parentElement : btn.parentElement && btn.parentElement.parentElement;
        for (var r = 0; rstHost && r < rstHost.children.length; r++) {
          if (rstHost.children[r].classList && rstHost.children[r].classList.contains("zu-ctxrst")) {
            if (rstTipFor === rstHost.children[r]) hideRstTip();
            rstHost.children[r].remove();
            break;
          }
        }
      }
      var cs = btn.querySelectorAll("circle");
      var v = cs.length >= 2 ? cs[1] : null;
      if (v) {
        v.removeAttribute("pathLength");
        v.removeAttribute("stroke-linecap");
        /* 还原原生 dash 语义：aria-label「上下文已用 X / 总量 Y」推回 offset；拿不到就退
         * 空环（offset=周长），React 数据更新时会写回准确值。 */
        var ratio = 0, nat = parseNativeCtxLabel(btn.getAttribute("aria-label"));
        if (nat) ratio = nat.pct / 100;
        v.setAttribute("stroke-dasharray", ZU_CTX_CIRC + " " + ZU_CTX_CIRC);
        v.setAttribute("stroke-dashoffset", String(ZU_CTX_CIRC * (1 - ratio)));
      }
    }

    /* ---------- v146 精简模式速率 chip（.zu-tsb）：工具行、重置卡左侧 ----------
     * 仅精简主题挂载（其余主题 restoreTpsChip 摘除）。挂载面与重置卡同源：工具行的
     * React 兄弟插入区，位置兜回 = 额度组 wrapper（或重置卡）左侧；双 reapply
     * （render/updateLive 数据点 + heavy 对账点）+ __zuSig 签名幂等。内容与条面
     * 速度 chip 同源（zuBarSpeedView 桥两态 / tpsBand DB 回退），无有效样本不渲染
     * （与条面口径一致：用户拍板「无数据隐藏」，代价是新会话首次请求前无设置入口）。 */
    function tpsChipView() {
      var cAvg = (lastView && lastView.session && typeof lastView.session.avg_tps === "number" &&
                  isFinite(lastView.session.avg_tps) && lastView.session.avg_tps > 0) ? lastView.session.avg_tps : 0;
      var sv = liveStatsCur ? zuBarSpeedView(liveStatsCur, bridge.handle && bridge.handle.charsPerToken, subRate.sum, cAvg) : null;
      if (sv) {
        liveKindCur = "live";
        livePhaseCur = sv.phase || "";
        return { kind: "live", sv: sv };
      }
      var dbTps = lastView && lastView.last ? lastView.last.tps : 0;
      if ((cAvg || dbTps) && isFinite(cAvg || dbTps) && (cAvg || dbTps) > 0) {
        liveKindCur = "fallback";
        livePhaseCur = "";
        return { kind: "fallback", dbTps: dbTps, sessAvg: cAvg, band: tpsBand(cAvg || dbTps) };
      }
      liveKindCur = "none";
      livePhaseCur = "";
      return null;
    }
    function tpsRowHtml(k, v) {
      return '<div class="tps-row"><span class="tps-k">' + k + '</span><span class="tps-v">' + ttEsc(v) + "</span></div>";
    }
    function tpsChipTipHTML(t) {
      var v = t.v, view = t.view || {};
      var sess = view.session || {}, lt = view.last_turn || {}, today = view.today || {}, last = view.last || {};
      var tls = view.tools || { total: 0, errors: 0 };
      /* 作用域样式挂在内容串里（同 rstTipHTML）：浮层是 body 级共享元素，样式随内容走 */
      var out = "<style>" +
        ".zusage-tps-tip .tps-h{font-weight:600;margin:0 0 7px}" +
        ".zusage-tps-tip .tps-sec{font-weight:600;margin:9px 0 2px}" +
        ".zusage-tps-tip .tps-row{display:flex;gap:10px;margin:4px 0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}" +
        ".zusage-tps-tip .tps-k{flex:0 0 auto;min-width:76px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
        ".zusage-tps-tip .tps-v{flex:1;min-width:0}" +
        ".zusage-tps-tip .tps-subrow{cursor:pointer}" +
        ".zusage-tps-tip .tps-subrow:hover .tps-v{color:var(--color-tooltip-foreground,#fafafa);text-decoration:underline}" +
        ".zusage-tps-tip .tps-note{display:flex;align-items:center;gap:10px;margin-top:8px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent));color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
        ".zusage-tps-tip .tps-note-t{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}" +
        ".zusage-tps-tip .tps-cfg{flex:0 0 auto;margin-left:auto;background:none;border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:999px;color:inherit;font:inherit;font-size:.85em;line-height:1.5;padding:0 9px;cursor:pointer}" +
        ".zusage-tps-tip .tps-cfg:hover{color:var(--color-tooltip-foreground,#fafafa);border-color:var(--color-border-hover,rgba(255,255,255,.24))}" +
        "</style>";
      var speedMain, speedMainCls = "", speedScope, speedSubLabel = "", speedSub = "", speedBandTag = "";
      if (v.kind === "live") {
        speedScope = v.sv.phase ? L("生成中估算", "Running estimate") : L("本轮完成 · 真实值", "Turn completed · actual");
        speedMain = v.sv.text;
        speedMainCls = (v.sv && v.sv.cls) || "";
        if (v.sv && typeof v.sv.latest === "number") { speedSubLabel = L("最近一轮", "Latest turn"); speedSub = v.sv.latest.toFixed(1); }
        speedBandTag = (v.sv && v.sv.band) ? tpsBandText(v.sv.band) : "";
      } else {
        var mainTpsC = v.sessAvg || v.dbTps;
        var bandC = tpsBand(typeof mainTpsC === "number" && isFinite(mainTpsC) ? mainTpsC : -1);   // 非数值（布尔旗标等）不入档
        speedScope = v.sessAvg ? L("会话平均", "Session average") : L("最近一段", "Latest segment");
        speedMain = (mainTpsC % 1 ? mainTpsC.toFixed(1) : String(mainTpsC));
        speedMainCls = bandC.cls;
        speedSubLabel = (v.sessAvg && v.dbTps > 0) ? L("最近一段", "Latest segment") : "";
        speedSub = (v.sessAvg && v.dbTps > 0) ? String(v.dbTps) : "";
        speedBandTag = tpsBandText(v.band);
      }
      /* v222：时间范围行——会话均/桥态取会话累计口径，「最近一段」回退态取段范围
       * （与会话累计 tooltip 同款式）。 */
      var chipSpan = (v.kind === "live" || v.sessAvg)
        ? speedSpan(sess.started, sess.last_at)
        : speedSpan(last.startedAt, last.endedAt);
      /* v255：精简模式速度 chip 也走 V2 整卡（此前只接了全量状态条两条路径，
       * compact 下 hover 一直显示旧「统计口径 + 10 根粗柱」）。筛选/悬停状态挂数据包，
       * tpsTip 浮层委托见模块层；旧快照缺轮表时原样回退旧摘要卡。 */
      var cv2 = spdRebuildOr(t && t.speedHistory, (t && t.speedSel) ||
        { range: "recent", period: "recent", dim: "time" },
        (t && typeof t.speedHover === "number") ? t.speedHover : -1, t && t.speedLive,
        { fmtTok: fmt, fmtCnt: countFmt, fmtMoney: state.cost ? fmtMoney : null }, sess);
      if (cv2) return cv2((t && typeof t.speedHover === "number") ? t.speedHover : -1, t.speedSel);
      try { FATAL.spdTip = { t: Date.now(), src: "fb-chip",
        turns: t && t.speedHistory && t.speedHistory.turns ? t.speedHistory.turns.length : -1 }; } catch (_) { }
      out += speedCardHTML({
        scope: speedScope,
        main: speedMain,
        mainCls: speedMainCls,
        noUnit: v.kind === "live" && v.sv && v.sv.phase,
        subLabel: speedSubLabel,
        sub: speedSub,
        bandTag: speedBandTag,
        curCls: speedMainCls,
        timeStart: chipSpan ? chipSpan.start : "",
        timeEnd: chipSpan ? chipSpan.end : "",
        basisTitle: L("统计口径", "Basis"),
        basisText: v.kind === "live"
          ? [L("按文本增量算出的字符/s，除以「每 token 字符数」估算 tok/s；比例取自本会话最近完成的真实轮次。", "chars/s from text deltas divided by a chars-per-token ratio calibrated from this session's latest completed turn.")]
          : (v.sessAvg
            ? [L("Σ输出（含思考）÷ 生成耗时", "Σoutput (thinking incl.) ÷ generation time")]
            : [L("输出 tokens（含思考）÷ 生成耗时", "output tokens (thinking incl.) ÷ generation time")])
      });
      /* 状态条摘要（用户拍板：隐藏格数据收进速率 tooltip）：逐格开关继续生效——
       * 关掉的格不出摘要行；子代理行可点击开明细面板（条面 .zu-sub 格的替身入口）。 */
      out += '<div class="tps-sec">' + L("状态条摘要", "Bar summary") + "</div>";
      if (state.show.turn) {
        out += tpsRowHtml(L("本轮", "Latest turn"), fmt(lt.total) + L(" token · ", " token · ") + countFmt(lt.requests || 0) + L("次", " req") + (lt.avg_duration_ms ? " · " + sec(lt.avg_duration_ms) : "") + costSuffix(lt.cost_usd));   /* v211 摘要时长随格面口径改平均值 */
      }
      if (state.show.win) {
        out += tpsRowHtml(L("会话累计", "Session"), fmt(sess.total) + L(" token · ", " token · ") + countFmt(sess.requests || 0) + L("次", " req") + costSuffix(sess.cost_usd));
      }
      if (state.show.today) {   // v213 摘要行序随格序对齐（用户规格 2026-11-02）
        out += tpsRowHtml(L("今日合计", "Today"), fmt(today.total) + L(" token · ", " token · ") + countFmt(today.requests || 0) + L("次", " req") + costSuffix(today.cost_usd));
      }
      if (state.show.proj && sess.project) {   // v159：项目累计摘要行（与会话累计同款口径）
        var pj2 = sess.project;
        out += tpsRowHtml(L("项目累计", "Project"), fmt(pj2.total) + L(" token · ", " token · ") + countFmt(pj2.sessions || 0) + L("会话 · ", " sessions · ") + countFmt(pj2.requests || 0) + L("次", " req") + costSuffix(pj2.cost_usd));
      }
      if (state.show.tools) {
        out += tpsRowHtml(L("工具调用", "Tool calls"), countFmt(tls.total || 0) + (tls.errors ? L("（错误 ", " (errors ") + countFmt(tls.errors) + "）" : ""));
      }
      if (state.show.sub) {
        var subA = view.sub || { total: 0, active: false };
        out += '<div class="tps-row tps-subrow" data-zusage-sub="1"><span class="tps-k">' + L("子代理", "Sub-agents") + '</span><span class="tps-v">' +
          ttEsc(fmt(subA.total || 0) + L(" token", " token") + (subA.active ? L(" · 运行中", " · running") : "") + L(" · 点击查看", " · click to view")) + "</span></div>";
      }
      out += modelsBlock(sess.models);   // v202：模型统计明细（含费用与 ? 图标，与统计格同构）
      out += tpsBandLegend(speedMainCls);
      out += '<div class="tps-note"><span class="tps-note-t">' + L("精简模式：状态条已收进工具行，各图标悬停看明细。", "Compact mode: the status bar lives in the toolbar — hover the chips for details.") +
        '</span><button type="button" class="tps-cfg">' + L("打开设置", "Open settings") + "</button></div>";
      return out;
    }
    function wireTpsChip(chip) {
      chip.__zuWired = true;
      /* 「打开设置」镜像齿轮开启分支（previousPanelFocus 落在 chip 上，关闭时焦点归还）；
       * 子代理行复用统一浮层开关（positionSubPop 在精简下贴 chip 定位）。 */
      chip.__zuOpen = function () {
        if (panel.classList.contains("open")) return;
        previousPanelFocus = chip;
        syncPanel();
        panel.classList.add("open");
        panel.setAttribute("aria-modal", "false");
        gear.setAttribute("aria-expanded", "true");
        panel.style.height = "";
        positionSettingsPanel();
        subPopClose(false, "chip-open");
        var activeNav = panel.querySelector('.zu-navitem[aria-current="page"]');
        if (activeNav && activeNav.focus) activeNav.focus();
      };
      /* v217：精简入口同样开统一浮层（chip 自身已有速率 tooltip，只走 pinned 不做预览） */
      chip.__zuOpenSub = function () {
        if (subPopMode === "pinned") subPopClose(false, "chip");
        else subPopShow(chip, true);
      };
      chip.addEventListener("mouseenter", function () { cancelTpsHide(); showTpsTip(chip); });
      chip.addEventListener("mouseleave", scheduleTpsHide);   // 延迟收起：给指针移入 tooltip 留窗口（同重置卡桥）
      chip.addEventListener("focus", function () { showTpsTip(chip); });
      chip.addEventListener("blur", hideTpsTip);
      chip.addEventListener("keydown", function (e) { if (e.key === "Escape") hideTpsTip(); });
    }
    function syncTpsChip() {
      if (state.theme !== "compact") { restoreTpsChip(); return; }   // v146：速率 chip 是精简模式专属载体
      if (inactive()) { restoreTpsChip(); return; }
      var v = tpsChipView();
      if (!v) { restoreTpsChip(); return; }
      /* v147 挂载面（用户规格）：前导区、git chip 左侧——git 在时插它前面；git 不在时占其
       * 锚位（cua-entry 后方/前导区末尾），git 出现后两侧兜回收敛为 [锚][速率][git]
       * （git 的兜回容忍速率占相邻位，见 enhanceGitChip，否则逐拍互相拉锯）。
       * 前导区发现失败（异形布局）回落尾随区：重置卡/额度组 wrapper 左侧（v146 原挂载面）。 */
      var host = null, insBefore = null, afterNode = null;   // insBefore=插其前；afterNode=挂其后（锚位语义，与 git chip 同款）
      var mount = null;
      try { mount = gitMount(); } catch (e) { }
      if (mount) {
        host = mount.wrap;
        var g = null;
        for (var gi = 0; gi < host.children.length; gi++) {
          if (host.children[gi].classList && host.children[gi].classList.contains("zu-git")) { g = host.children[gi]; break; }
        }
        if (g) insBefore = g;            // git 在：速率紧贴其左
        else afterNode = mount.after;    // git 不在：占其锚位（cua-entry 后方；after=null=前导区末尾）
      } else {
        var btn = null;
        try { btn = (ctxBtnCache && ctxBtnCache.isConnected) ? ctxBtnCache : (cardCache ? cardCache.querySelector(ZU_CTX_TRIGGER) : null); } catch (e) { }
        if (!btn || !btn.parentElement || !btn.parentElement.parentElement) { restoreTpsChip(); return; }
        var wrap = btn.parentElement;
        host = wrap.parentElement;   // 工具行（group/toolbar）：与重置卡/额度组同一 React 兄弟插入区
        insBefore = wrap;
        for (var r = 0; r < host.children.length; r++) {
          if (host.children[r].classList && host.children[r].classList.contains("zu-ctxrst")) { insBefore = host.children[r]; break; }
        }
      }
      var chip = tpsChipCache;
      if (!chip || !chip.isConnected || chip.parentElement !== host) {
        if (chip && chip.isConnected) chip.remove();
        chip = null;
        for (var i = 0; i < host.children.length; i++) {   // 复用遗留节点防双 chip（同额度 chip）
          if (host.children[i].classList && host.children[i].classList.contains("zu-tsb")) { chip = host.children[i]; break; }
        }
        if (!chip) {
          chip = document.createElement("span");
          chip.className = "zu-tsb";
          chip.tabIndex = 0;
          host.appendChild(chip);
        }
        /* v155：新建与跨代采纳统一走挂装（__zuWired 防重）；遗留节点上的旧代监听随
         * __zuOpen 缺失一并补齐，否则热更采纳的 chip 悬停/键盘/设置入口全部失效。 */
        if (!chip.__zuWired) wireTpsChip(chip);
        tpsChipCache = chip;
      }
      var misplaced;
      /* 用 nextElementSibling 判位（nextSibling 会被文本节点打乱，造成每拍重插） */
      if (insBefore) misplaced = chip.nextElementSibling !== insBefore;
      else misplaced = (afterNode ? afterNode.nextElementSibling !== chip : host.lastElementChild !== chip);   // 锚位语义同 git 兜回（下一元素已是自己=就位，不得自插）
      if (misplaced) host.insertBefore(chip, insBefore ? insBefore : (afterNode ? afterNode.nextElementSibling : null));
      var txt = v.kind === "live" ? v.sv.text
        : (v.sessAvg ? L("均", "avg ") + v.sessAvg + " t/s" : v.dbTps + " t/s");   /* v228：去「· 近X」尾缀，与条面格同口径（用户规格） */
      var cls = "zu-live " + (v.kind === "live" ? v.sv.cls + (v.sv.word ? " zu-shimmer" : "") : v.band.cls);
      var sig = v.kind + "|" + cls + "|" + txt;
      if (chip.__zuSig !== sig) {   // 幂等：内容没变不重建，悬停/焦点态不被打断
        chip.__zuSig = sig;
        chip.innerHTML = '<span class="' + cls + '">' + ttEsc(txt) + "</span>";
        chip.setAttribute("aria-label", L("生成速度 ", "Generation speed ") + txt);
      }
      var prevT = chip.__zuT;
      chip.__zuT = { v: v, view: lastView, buildTip: tpsChipTipHTML,
        /* v255：V2 轮表与筛选/悬停状态随 chip 包走，10Hz 心跳不重置用户选择 */
        speedHistory: (state.data && state.data.speed_history) || (prevT && prevT.speedHistory) ||
          (typeof lastSpeedHistory !== "undefined" && lastSpeedHistory) || null,
        speedSel: (prevT && prevT.speedSel) || { range: "recent", period: "recent", dim: "time" },
        speedHover: prevT && typeof prevT.speedHover === "number" ? prevT.speedHover : -1,
        speedLive: v.kind === "live" ? v.sv : null };
      var lite = bar.classList.contains("zu-light");
      syncCtxLite(chip, lite);
      chip.classList.toggle("zu-light", lite);   // 速率档色的浅色组按 .zu-light 祖先匹配（条隐藏后祖先缺失，类挂 chip 自身补链）
      if (tpsTipFor === chip) showTpsTip(chip);   // 悬停中随心跳/推送刷新：签名不变不重建
    }
    function restoreTpsChip() {
      if (!tpsChipCache) return;
      if (tpsTipFor === tpsChipCache) hideTpsTip();
      try { tpsChipCache.remove(); } catch (e) { }
      tpsChipCache = null;
    }

    /* ---------- v96 套餐额度 chip：原生上下文按钮左侧 ----------
     * 挂载面与按钮增强同源：wrapper（tooltip-trigger span）的 React children 只有 button，
     * 前插的手动节点不受 reconcile 清理；双 reapply（render 数据点 + heavy 对账点）兜回位置
     * 与内容；dispose / 关闭开关 / 无数据一律摘除。显示门控：开关开 + 本 pane 会话已有完成的
     * main_turn（provider_id 已知）+ provider 为内置套餐档；自定义 provider 隐藏，团队档给
     * 不支持提示。数据账号级（快照 quota 字段），同套餐换模型只换 tooltip 高亮不重查。 */
    function quotaBandOf(pct) { return bandOf(QUOTA_BANDS, pct); }
    /* chip 分段：每个窗口一段（5小时/7天），各自按已用 % 上档位色；余额类型一段（阶段 3 数据源接入即用） */
    function quotaSegs(q) {
      var w = q && q.windows, out = [];
      if (!w) return out;
      var defs = [["daily", "今日", "1d"], ["fiveHour", "5小时", "5h"], ["weekly", "7天", "7d"], ["monthly", "本月", "1mo"], ["plan", "套餐", "plan"]];
      for (var i = 0; i < defs.length; i++) {
        var e = w[defs[i][0]];
        /* isFinite 门：NaN/±Infinity 不进分段，绝不落成正常色（v127） */
        if (e && typeof e.percent === "number" && isFinite(e.percent)) out.push({ label: L(defs[i][1], defs[i][2]), pct: e.percent });
      }
      return out;
    }
    function quotaChipMode() {
      if (!state.quotaEnabled) return null;
      /* 会话有请求历史 → 跟随本会话最近完成的请求；无历史（新会话/刚切模型）→ 跟随快照
       * 顶层 provider_fallback（账号最近套餐档），消除切模型到首请求完成的 chip 空窗。 */
      var prov = effectiveQuotaProvider();
      if (!prov) return null;
      if (prov.indexOf("account:") === 0 && prov.indexOf("team") >= 0) {
        return { kind: "team", html: '<span class="zu-qwarn">⊘</span>', aria: L("团队套餐额度暂不支持", "Team plan quota not supported yet") };   // 静态提示不依赖数据
      }
      if (!lastQuota) return null;
      /* 按 provider 选源：内置 account:* → family 源；自定义 → byProvider 映射（主进程
       * noteProvider 时记录），未映射的自定义退 custom 源。多窗异 provider 各取各的源。 */
      var q = lastQuota, st = q.status;
      if (st === "disabled") return null;   // 源被 ⚙ 显式关闭：尊重显式关闭，不展示
      if (st === "not_configured" || st === "unsupported") {   // v111 不再静默隐藏：中性灰提示引导去 ⚙ 配置
        var dimTxt = st === "not_configured" ? L("额度 未配置", "Quota unset") : L("额度 暂不支持", "Quota unsupported");
        return { kind: "info", html: '<span class="zu-qseg dim">' + dimTxt + "</span>", aria: dimTxt };
      }
      var warn = (st !== "ok" && st !== "idle") ? '<span class="zu-qwarn">⚠</span>' : "";
      var bal = q.balance;
      if (bal && typeof bal.amount === "number" && isFinite(bal.amount)) {
        var amt = quotaBalanceText(bal);
        return { kind: "balance", stale: !!q.stale, busy: !!q.busy,
          html: '<span class="zu-qseg zu-qb-calm">' + (state.lang === "en" ? "" : "余额 ") + amt + "</span>" + warn,
          aria: L("余额 ", "Balance ") + quotaBalanceText(bal, true) };
      }
      var segs = quotaSegs(q);
      if (segs.length) {
        var rem = state.quotaRemain === 1;   // v251 显示口径：缺省已用%，开启后剩余%（数字取 100−已用的补数）
        var shownOf = function (pct) { return Math.round(rem ? quotaRemainPct(pct) : pct); };
        var html = segs.map(function (s) {
        /* v127：周期标签拆 zu-qlabel 子节点（静态 L() 文案，安全）——标签与数值同档色同字重成组。
         * textContent 与原有完全一致，aria/tooltip 不受影响。档位色恒按已用原始值判定，不随口径反转。 */
          return '<span class="zu-qseg ' + quotaBandOf(s.pct) + '"><span class="zu-qlabel">' + s.label + '</span> ' + shownOf(s.pct) + "%</span>";
        }).join('<span class="zu-qsep">|</span>');
        return { kind: "value", stale: !!q.stale, busy: !!q.busy,
          html: html + warn,
          aria: (rem ? L("套餐剩余 ", "Plan remaining ") : L("套餐已用 ", "Plan used ")) + segs.map(function (s) { return s.label + " " + shownOf(s.pct) + "%"; }).join(L("，", ", ")) };
      }
      var summary = q.quotaSummary;
      if (summary && typeof summary.remaining === "number" && isFinite(summary.remaining)) {
        var left = quotaBalanceText({ amount: summary.remaining, currency: summary.currency });
        return { kind: "quota", stale: !!q.stale, busy: !!q.busy, html: '<span class="zu-qseg zu-qb-calm">' + L("额度 ", "Quota ") + left + "</span>" + warn,
          aria: L("Key 剩余额度 ", "Key quota remaining ") + quotaBalanceText({ amount: summary.remaining, currency: summary.currency }, true) };
      }
      if (st === "ok" || st === "idle") return null;   // 还没有可显示的窗口（首查在途/接口回空）
      return { kind: "error", html: '<span class="zu-qwarn">⚠</span>', aria: quotaStatusText(st) || st };
    }
    function onQuotaClick(e) {
      e.preventDefault();
      e.stopPropagation();
      pluginRequest("quota-refresh", quotaSourceId ? { sourceId: quotaSourceId } : undefined);
    }
    function enhanceQuotaChip() {
      if (inactive()) { restoreQuotaChip(); return; }
      var mode = quotaChipMode();
      if (!mode) { restoreQuotaChip(); return; }
      var btn = null;
      try { btn = (ctxBtnCache && ctxBtnCache.isConnected) ? ctxBtnCache : (cardCache ? cardCache.querySelector(ZU_CTX_TRIGGER) : null); } catch (e) { }
      if (!btn || !btn.parentElement) { restoreQuotaChip(); return; }
      var wrap = btn.parentElement;
      var chip = quotaChipCache;
      if (!chip || !chip.isConnected || chip.parentElement !== wrap) {
        if (chip && chip.isConnected) chip.remove();
        chip = null;
        for (var i = 0; i < wrap.children.length; i++) {   // 复用热更/重建遗留的同类节点，避免双 chip
          if (wrap.children[i].classList && wrap.children[i].classList.contains("zu-quota")) { chip = wrap.children[i]; break; }
        }
        if (!chip) {
          chip = document.createElement("span");
          chip.className = "zu-quota";
          chip.setAttribute("role", "button");
          chip.setAttribute("aria-keyshortcuts", "Enter Space");
          chip.tabIndex = 0;
          chip.addEventListener("mouseenter", onQuotaEnter);
          chip.addEventListener("mouseleave", hideQuotaTip);
          chip.addEventListener("focus", onQuotaEnter);
          chip.addEventListener("blur", hideQuotaTip);
          chip.addEventListener("keydown", onRefreshKeydown);
          chip.addEventListener("keyup", onRefreshKeyup);
          chip.addEventListener("click", onQuotaClick);
        }
        quotaChipCache = chip;
      }
      if (chip.nextElementSibling !== btn) wrap.insertBefore(chip, btn);   // 位置兜回：始终紧贴按钮左侧
      var liveState = lastQuota && lastQuota.busy ? L("套餐额度查询中", "Plan quota query in progress") : mode.aria;
      if (ariaLiveState.__zuQuotaLive !== liveState) {
        ariaLiveState.__zuQuotaLive = liveState;
        ariaLiveState.textContent = ariaLiveState.__zuQuotaLive || ariaLiveState.__zuGitLive || "";
      }
      syncCtxLite(chip, bar.classList.contains("zu-light"));
      var srcLabels = {};
      for (var si = 0; si < (state.quotaSources || []).length; si++) srcLabels[state.quotaSources[si].id] = state.quotaSources[si].label;
      var all = lastQuotaAll && lastQuotaAll.sources ? Object.assign({}, lastQuotaAll, { active: quotaSourceId }) : lastQuotaAll;
      chip.__zuQ = { q: lastQuota, all: all, srcLabels: srcLabels, provider: quotaProvider, model: quotaModel, mode: mode };
      var sig = mode.kind + "|" + (mode.stale ? 1 : 0) + "|" + mode.html;
      var qbusy = !!(lastQuota && lastQuota.busy);
      if (chip.__zuSig !== sig) {   // 幂等：内容没变不重建，悬停/焦点态不被打断
        chip.__zuSig = sig;
        chip.className = "zu-quota" + (mode.stale ? " zu-qstale" : "") + (qbusy ? " zu-qbusy" : "");
        chip.setAttribute("aria-label", mode.aria);
        chip.innerHTML = mode.html;
      }
      chip.classList.toggle("zu-qbusy", qbusy);
      chip.setAttribute("aria-busy", String(qbusy));
      if (quotaTipFor === chip) showQuotaTip(chip);   // 悬停中数据刷新：内容跟随
    }
    function restoreQuotaChip() {
      if (!quotaChipCache) return;
      if (quotaTipFor === quotaChipCache) hideQuotaTip();
      try { quotaChipCache.remove(); } catch (e) { }
      quotaChipCache = null;
      ariaLiveState.__zuQuotaLive = "";
      ariaLiveState.textContent = ariaLiveState.__zuGitLive || "";
    }

    /* ---------- v124 Git 状态 chip：始终挂在工具行左侧操作区 ----------
     * 样式移植 cc-pretty-statusline 的 git 段：⎇ 分支 ↑N ↓N (+插入行 -删除行 ?未跟踪文件)。
     * 数据：模块级 gitViewFor(scope.workspacePath)（主进程旁路查询推送）；本 pane 的 scope 为远端
     * （identity 非空）/ 未知 / 非仓库 / 无 git 时不挂载。稳定性同 v92：自有节点插在 React children
     * 之间（React 既不复用也不清理外来节点），位置由 render/heavy 双 reapply 兜回；内容签名幂等。 */
    function gitMount() {
      if (!cardCache) return null;
      function live(el) {
        if (!el.isConnected || !el.parentElement || inGhostSubtree(el)) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      var leading = cardCache.querySelectorAll('[data-composer-leading-content]');
      for (var i = 0; i < leading.length; i++) {
        var wrap = leading[i];
        if (!live(wrap)) continue;
        var buttons = wrap.querySelectorAll('[data-testid="v4-composer-cua-entry"]');
        for (var j = 0; j < buttons.length; j++) {
          if (live(buttons[j]) && buttons[j].parentElement === wrap) return { wrap: wrap, btn: buttons[j], after: buttons[j] };
        }
        var modes = wrap.querySelectorAll('[data-testid="chat-mode-select-trigger"]');
        for (var m = 0; m < modes.length; m++) {
          if (live(modes[m])) return { wrap: wrap, btn: modes[m], after: null };
        }
        return { wrap: wrap, btn: wrap, after: null };
      }
      var selectors = ['[data-testid="v4-composer-cua-entry"]', '[data-testid="chat-mode-select-trigger"]'];
      for (var k = 0; k < selectors.length; k++) {
        var candidates = cardCache.querySelectorAll(selectors[k]);
        for (var n = 0; n < candidates.length; n++) {
          var btn = candidates[n];
          if (!live(btn)) continue;
          var anchor = btn;
          while (anchor.parentElement && anchor.parentElement !== cardCache &&
                 !(anchor.parentElement.classList && anchor.parentElement.classList.contains("group/toolbar"))) anchor = anchor.parentElement;
          var parent = anchor.parentElement;
          if (parent && parent !== cardCache && parent.classList && parent.classList.contains("group/toolbar"))
            return { wrap: parent, btn: btn, after: anchor };
        }
      }
      return null;
    }
    var ZU_GIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>';
    /* v96 multi：多仓库聚合态图标 = lucide folder-git 官方 path 数据（描边宽对齐 ZU_GIT_ICON 的 1.5） */
    var ZU_GIT_MULTI_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="13" r="2"></circle>' +
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>' +
      '<path d="M14 13h3"></path><path d="M7 13h3"></path></svg>';
    function gitChipView() {   // null = 本 pane 当前不该显示 chip
      if (!state.show.git) return null;
      var scope = readPaneScope(wantedEl, pickedSid, pid);
      if (!scope || scope.identity || !scope.workspacePath) return null;
      var v = gitViewFor(scope.workspacePath);
      return v ? { path: scope.workspacePath, st: v.st, stale: v.stale } : null;
    }
    function gitChipHtml(view) {   // view={path, st, stale}：stale 是工作区级过期标志（勿与闭包 stale() 函数混淆）
      var st = view.st, stale = view.stale;
      if (st.kind === "multi") {   // v96 multi：仓库数 + ·分隔语义段（已知/上次前缀、!冲突、失败、过期）；文件条目汇总在 tooltip 不上 chip
        var agg = gitMultiAgg(st), parts = ['<span class="zu-git-name">' + agg.total + L("仓", " repos") + "</span>"];
        var prefix = agg.failed > 0 ? L("已知", "") : (agg.staleAny || stale) ? L("上次", "last ") : "";
        if (agg.changed > 0) parts.push('<span class="zu-git-dirty">' + prefix + agg.changed + L("改", " changed") + "</span>");   // 有改动仓库数；任一确认冲突时整段红（.zu-conflict）
        if (agg.conflict > 0) parts.push('<span class="zu-git-conflict">!' + agg.conflict + L("冲突", " conflicted") + "</span>");   // 确认冲突的仓库数
        if (agg.failed > 0) parts.push('<span class="zu-git-warn">' + agg.failed + L("失败", " failed") + "</span>");
        if (stale) parts.push('<span class="zu-git-warn">' + L("过期", "stale") + "</span>");   // 过期用文字提示，不降透明度
        return ZU_GIT_MULTI_ICON + parts.join('<span class="zu-git-sep">·</span>');
      }
      var name = st.detached ? "HEAD" : st.noCommits ? L("初始", "init") : String(st.branch || "HEAD");
      var shown = name.length > 18 ? name.slice(0, 16) + "…" : name;   // 全名进 tooltip
      var h = ZU_GIT_ICON + '<span class="zu-git-name">' + gitEsc(shown) + "</span>";
      var ab = (st.ahead > 0 ? "↑" + gitNum(st.ahead) : "") + (st.behind > 0 ? (st.ahead > 0 ? " " : "") + "↓" + gitNum(st.behind) : "");
      if (ab) h += '<span class="zu-git-ab">' + ab + "</span>";
      var nums = [];
      if (st.ins > 0) nums.push('<span class="zu-git-ins">+' + gitNum(st.ins) + "</span>");
      if (st.del > 0) nums.push('<span class="zu-git-del">-' + gitNum(st.del) + "</span>");
      var d = nums.join(" ") + (nums.length && st.untracked > 0 ? '<span class="zu-git-sep">·</span>' : "") + (st.untracked > 0 ? '<span class="zu-git-unt">?' + gitNum(st.untracked) + "</span>" : "");
      if (d) h += '<span class="zu-git-d">(' + d + ")</span>";   // 无任何改动时整段不出现
      if ((st.conflicts | 0) > 0) h += ' <span class="zu-git-conflict">!' + gitNum(st.conflicts) + L("冲突", " conflicted") + "</span>";
      if (st.op) h += ' <span class="zu-git-op">' + gitEsc(gitOpLabel(st.op)) + "</span>";
      if (stale) h += ' <span class="zu-git-warn">' + L("过期", "stale") + "</span>";
      return h;
    }
    function gitChipAria(st, stale) {
      if (st.kind === "multi") {
        var a = gitMultiAgg(st);
        var ms = L("Git " + a.total + " 个仓库", "Git " + a.total + " repos");
        if (a.changed > 0 || a.failed > 0) ms += L("，" + (a.failed > 0 ? "已知 " : "") + a.changed + " 个有改动", ", " + a.changed + " with changes");
        if (a.conflict > 0) ms += L("，" + a.conflict + " 个仓库冲突", ", " + a.conflict + " repos conflicted");
        if (a.op > 0) ms += L("，" + a.op + " 个操作中", ", " + a.op + " mid-operation");
        if (a.failed > 0) ms += L("，" + a.failed + " 个查询失败", ", " + a.failed + " failed");
        if (stale) ms += L("，数据已过期", ", data stale");
        return ms;
      }
      var s = L("Git 分支 ", "Git branch ") + (st.detached ? "HEAD" : st.noCommits ? L("初始（尚无首次提交）", "init (no initial commit yet)") : st.branch);
      if (st.ahead > 0) s += L("，领先 ", ", ahead ") + st.ahead;
      if (st.behind > 0) s += L("，落后 ", ", behind ") + st.behind;
      if (st.ins > 0 || st.del > 0) s += L("，改动 +", ", changes +") + (st.ins | 0) + " -" + (st.del | 0);
      if (st.untracked > 0) s += L("，未跟踪 ", ", untracked ") + st.untracked;
      if ((st.conflicts | 0) > 0) s += L("，! " + st.conflicts + " 个冲突文件", ", ! " + st.conflicts + " conflicted files");
      if (st.op) s += L("，进行中操作：", ", git operation: ") + gitOpLabel(st.op);
      if (stale) s += L("，数据已过期", ", data stale");
      return s;
    }
    function onGitEnter() { showGitTip(this); }
    function onGitClick(e) {
      e.preventDefault();
      e.stopPropagation();
      if (gitRefreshRequestId) return;
      var scope = readPaneScope(wantedEl, pickedSid, pid);
      var targetPath = scope ? scope.workspacePath : "";
      if (!targetPath) return;
      this.classList.add("zu-gbusy");
      this.setAttribute("aria-busy", "true");
      gitRefreshPath = targetPath;
      announceGitRefresh();
      var requestId = "";
      var refreshScopeStamp = JSON.stringify({ sid: pickedSid || "", identity: scope.identity, workspacePath: scope.workspacePath });
      var requested = askGitRefresh(true, function (result) {
        if (inactive() || gitRefreshRequestId !== requestId) return;
        var currentScope = readPaneScope(wantedEl, pickedSid, pid);
        var currentScopeStamp = JSON.stringify(currentScope && {
          sid: currentScope.sid, identity: currentScope.identity, workspacePath: currentScope.workspacePath,
        });
        if (currentScopeStamp !== refreshScopeStamp) { cancelGitRefresh(); return; }
        gitRefreshRequestId = "";
        gitRefreshPath = "";
        if (gitChipCache) { gitChipCache.classList.remove("zu-gbusy"); gitChipCache.setAttribute("aria-busy", "false"); }
        enhanceGitChip();
        var view = gitChipView();
        var summary = view ? gitChipAria(view.st, view.stale) : L("当前目录没有 Git 状态", "No Git status for this directory");
        var text = result && result.ok
          ? L("Git 状态已更新：", "Git status updated: ") + summary
          : L("Git 状态查询失败：", "Git status query failed: ") + summary;
        ariaLiveState.__zuGitLive = text;
        ariaLiveState.textContent = text;
      });
      if (!requested) {
        gitRefreshRequestId = "";
        gitRefreshPath = "";
        if (gitChipCache) { gitChipCache.classList.remove("zu-gbusy"); gitChipCache.setAttribute("aria-busy", "false"); }
        var currentView = gitChipView();
        var currentStatus = currentView ? gitChipAria(currentView.st, currentView.stale) : "";
        ariaLiveState.__zuGitLive = currentStatus;
        ariaLiveState.textContent = currentStatus || ariaLiveState.__zuQuotaLive || "";
        enhanceGitChip();
      } else {
        requestId = (window.__zusagePluginRequests[window.__zusagePluginRequests.length - 1] || {}).requestId || "";
        gitRefreshRequestId = requestId;
        if (!requestId) {
          gitRefreshPath = "";
          if (gitChipCache) { gitChipCache.classList.remove("zu-gbusy"); gitChipCache.setAttribute("aria-busy", "false"); }
        }
      }
    }
    function announceGitRefresh() {
      if (!ariaLiveState || !gitRefreshPath) return;
      var busyText = L("Git 状态查询中", "Checking Git status");
      if (ariaLiveState.__zuGitLive !== busyText) {
        ariaLiveState.__zuGitLive = busyText;
        ariaLiveState.textContent = busyText;
      }
    }
    function cancelGitRefresh() {
      if (!gitRefreshRequestId) return;
      gitRefreshRequestId = "";
      gitRefreshPath = "";
      if (gitChipCache) {
        gitChipCache.classList.remove("zu-gbusy");
        gitChipCache.setAttribute("aria-busy", "false");
      }
      ariaLiveState.__zuGitLive = "";
      ariaLiveState.textContent = ariaLiveState.__zuQuotaLive || "";
    }
    function gitChipCompact(btn, chip, html, mount) {
      if (btn.getAttribute("data-composer-compact") === "true") return true;
      if (!chip.classList.contains("zu-compact")) return false;
      var row = cardCache ? toolbarRowOf(cardCache) : null, probe = null;
      try {
        if (!row || !(row.clientWidth > 0)) return false;
        var content = mount && mount.wrap.hasAttribute("data-composer-leading-content") ? mount.wrap : row.querySelector("[data-composer-leading-content]");
        var available = content && content.parentElement && content.parentElement.hasAttribute("data-composer-leading-actions") ? content.parentElement : row.querySelector("[data-composer-leading-actions]");
        var trailing = row.querySelector("[data-composer-trailing-actions]");
        var hasLeading = content && available && content.hasAttribute("data-composer-leading-content") && available.hasAttribute("data-composer-leading-actions");
        var gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        var used = 0, room = row.clientWidth;
        if (hasLeading) {
          used = content.getBoundingClientRect().width;
          room = Math.min(available.getBoundingClientRect().width, row.getBoundingClientRect().width - (trailing && trailing.hasAttribute("data-composer-trailing-actions") ? trailing.getBoundingClientRect().width + gap : 0));
        } else {
          for (var i = 0; i < row.children.length; i++) used += row.children[i].getBoundingClientRect().width;
          used += Math.max(0, row.children.length - 1) * gap;
        }
        // 宿主的测量副本保留 zu-compact；只看当前余量会把收起的分支名误当作永久空闲。
        probe = chip.cloneNode(true);
        probe.innerHTML = html;
        probe.classList.remove("zu-compact");
        probe.setAttribute("aria-hidden", "true");
        probe.inert = true;
        probe.style.position = "fixed";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.width = "max-content";
        probe.style.maxWidth = "none";
        document.body.appendChild(probe);
        var fullWidth = probe.getBoundingClientRect().width;
        var currentWidth = chip.getBoundingClientRect().width;
        if (!(fullWidth > 0) || !(currentWidth > 0) || !(room > 0) || !(used > 0)) return false;
        return used + Math.max(0, fullWidth - currentWidth) + 32 > room;
      } catch (e) { return false; }
      finally { if (probe) probe.remove(); }
    }
    function enhanceGitChip() {
      if (inactive()) { restoreGitChip(); return; }
      var scope = readPaneScope(wantedEl, pickedSid, pid);
      var view = gitChipView();
      if (!view) { restoreGitChip(); return; }
      var mount = null;
      try { mount = gitMount(); } catch (e) { }
      if (!mount) { restoreGitChip(); return; }
      var btn = mount.btn, wrap = mount.wrap;
      var chip = gitChipCache;
      if (!chip || !chip.isConnected) {
        if (gitTipFor === chip) hideGitTip();
        chip = null;
        for (var i = 0; i < wrap.children.length; i++) {   // 复用热更/重建遗留的同类节点，避免双 chip
          if (wrap.children[i].classList && wrap.children[i].classList.contains("zu-git")) { chip = wrap.children[i]; break; }
        }
        if (!chip) {
          chip = document.createElement("span");
          chip.className = "zu-git";
          chip.setAttribute("role", "button");
          chip.setAttribute("aria-keyshortcuts", "Enter Space");
          chip.tabIndex = 0;
          chip.addEventListener("mouseenter", onGitEnter);
          chip.addEventListener("mouseleave", hideGitTipSoon);
          chip.addEventListener("focus", onGitEnter);
          chip.addEventListener("blur", hideGitTip);
          chip.addEventListener("keydown", onRefreshKeydown);
          chip.addEventListener("keyup", onRefreshKeyup);
          chip.addEventListener("click", onGitClick);
        }
        gitChipCache = chip;
      }
      /* 位置兜回：电脑操作后方，或左侧操作区末尾。容忍速率 chip 紧贴锚位（v147：精简模式
       * 速率在 git 左侧 = [锚][速率][git]，速率让位后 git 自然回贴锚位），否则两 chip 逐拍互相拉锯 */
      var slotNode = mount.after ? mount.after.nextSibling : null;
      var mis;
      if (!chip.isConnected) mis = true;   // 首挂必须插入：速率 chip 占锚位时先落其后再由速率兜回收敛 [锚][速率][git]（容忍规则只用于已挂载的位置保持，否则精简下 git chip 永不出现）
      else if (mount.after) mis = slotNode !== chip && !(tpsChipCache && slotNode === tpsChipCache);
      else mis = wrap.lastElementChild !== chip;
      if (mis) wrap.insertBefore(chip, slotNode);
      var gitLiveText = gitChipAria(view.st, view.stale);
      if (ariaLiveState.__zuGitLive !== gitLiveText) {
        ariaLiveState.__zuGitLive = gitLiveText;
        ariaLiveState.textContent = ariaLiveState.__zuGitLive || ariaLiveState.__zuQuotaLive || "";
      }
      syncCtxLite(chip, bar.classList.contains("zu-light"));
      chip.__zuGit = view;
      var html = gitChipHtml(view);
      var compact = gitChipCompact(btn, chip, html, mount);
      var mAgg = view.st.kind === "multi" ? gitMultiAgg(view.st) : null;
      var cls = "zu-git" + (compact ? " zu-compact" : "") + (view.st.kind === "multi" ? " zu-git-multi" : "") + (mAgg && mAgg.conflict > 0 ? " zu-conflict" : "");   // v96：形态类（紧凑态收起份数与聚合计数段）+ 确认冲突 → 冲突段转红（类进签名保持幂等）；过期走文字徽章不降透明度
      var sig = cls + "|" + html + "|" + state.lang;
      var busy = chip.classList.contains("zu-gbusy");
      if (chip.__zuSig !== sig) {   // 幂等：内容不变时不重建 chip
        chip.__zuSig = sig;
        chip.className = cls + (busy ? " zu-gbusy" : "");
        chip.setAttribute("aria-label", gitChipAria(view.st, view.stale));
        chip.innerHTML = html;
      }
      chip.classList.toggle("zu-gbusy", busy);
      chip.setAttribute("aria-busy", String(busy));
      if (gitTipFor === chip) showGitTip(chip);   // 悬停中数据刷新：内容跟随
    }
    function restoreGitChip() {
      gitRefreshPath = "";
      if (!gitChipCache) {
        ariaLiveState.__zuGitLive = "";
        ariaLiveState.textContent = ariaLiveState.__zuQuotaLive || "";
        return;
      }
      if (gitTipFor === gitChipCache) hideGitTip();
      try { gitChipCache.remove(); } catch (e) { }
      gitChipCache = null;
      ariaLiveState.__zuGitLive = "";
      ariaLiveState.textContent = ariaLiveState.__zuQuotaLive || "";
    }

    /* ---------- v105 压缩上下文：「上下文容量」弹层内、命中率行下方的胶囊按钮 ----------
     * 弹层（hover-card-content）关即卸载（Radix 无 forceMount），每次打开全新挂载——注入
     * 节点随之销毁，靠 body MutationObserver（即时）+ heavy 对账点（600ms 兜底）双触发重注
     * 入；以 DOM 存在性幂等，多实例并发安全。打开期间 React 只原地 patch，不会删除外来
     * 兄弟节点，最多相对移位（新 border-t 段出现时），同步时位置兜回（同 quota chip 3765 套路）。
     * 面板判别双指纹：!w-80（contextPanelWidthClass，全仓库唯一 important 宽）+ 内含 ui
     * Progress；插入锚=ContextContentBody（div.space-y-3）内「剩余额度」border-t 段之前
     * （命中率行在 <78% 时条件隐藏，锚定 border-t 段不受影响），缺则容器尾（仍是命中率行下）。
     * 确认后发送 /compact：优先 fiber 上原生残留的 onSendCompressionCommand（SessionPane
     * 压缩入口，最终 dispatchCommand("compact")，与手敲 /compact 同链、不动草稿、自带 toast）；
     * 缺失回落官方 E2E 输入桥（生产客户端无条件挂载）__zcodeLexicalInputE2E.setText +
     * 发送键。Lexical 的 contenteditable 直写不进 EditorState，该路径禁用；兜底通道会清写
     * 输入框，草稿非空一律拒绝。pane 归属：按几何就近的可见触发按钮（分栏各拿各的 fiber）。 */
    var ZU_HC_SEL = '[data-slot="hover-card-content"]';
    var compactDlg = null, compactDlgKey = null, compactAnchor = null, compactFn = null;
    var acFlashTimer = 0;   // v189：「调整」链接高亮阈值行的 3 秒计时器（dispose 清理）
    function nearestByRect(anchor, sel) {   // 可见元素中矩形中心离 anchor 最近者；隐藏 pane 不参与
      var list = [], r0 = null;
      try {
        list = document.querySelectorAll(sel);
        r0 = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
      } catch (e) { return null; }
      var best = null, bd = Infinity;
      var cx = r0 ? r0.left + r0.width / 2 : 0, cy = r0 ? r0.top + r0.height / 2 : 0;
      for (var i = 0; i < list.length; i++) {
        var r = null;
        try { r = list[i].getBoundingClientRect(); } catch (e) { }
        if (!r || r.width <= 0 || r.height <= 0) continue;
        var dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
        var d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = list[i]; }
      }
      return best;
    }
    function fiberPropFrom(el, prop) {   // 沿 __reactFiber$ 向上找 memoizedProps（限深 60 层）
      try {
        var ks = Object.keys(el), fk = "";
        for (var i = 0; i < ks.length; i++) {
          if (ks[i].indexOf("__reactFiber$") === 0) { fk = ks[i]; break; }
        }
        if (!fk) return null;
        var f = el[fk], n = 0;
        while (f && n++ < 60) {
          if (f.memoizedProps && typeof f.memoizedProps[prop] === "function") return f.memoizedProps[prop];
          f = f.return;
        }
      } catch (e) { }
      return null;
    }
    /* v179 阈值行文案：仅引擎补丁生效时返回文本（空串=不渲染）。阈值百分比 v194 起
       为总窗口口径（引擎 hook 以 eff+21K 近似还原标称窗口并钳在有效窗口内），设置值、
       本行百分比与原生按钮三者同口径；解析不到总量时只给 token 绝对值；token 数
       v191 起走 fmt()（万/亿/K·M·B 与状态条、tooltip 同一转换链，含强制 KMB 开关）。 */
    function acInfoText(body) {
      var ep = state.enginePatch;
      if (!ep || ep.state !== "applied") return "";
      var mc = acModeOf(ep.config);
      var cw = 0;
      try {
        var trig = nearestByRect(body, ZU_CTX_TRIGGER);
        var label = trig ? String(trig.getAttribute("aria-label") || "") : "";
        var m = label.match(/([\d,，]+)\s*\/\s*总量\s*([\d,，]+)/) || label.match(/([\d,]+)\s+of\s+([\d,]+)/i);
        if (m) cw = parseInt((m[2] || "").replace(/[,,]/g, ""), 10);
      } catch (e) { }
      if (mc.mode === "default") {
        /* 引擎默认阈值 = 窗口 − 21K 预留 − 13K 缓冲（policy.ts 常量）：窗口已知按现算，未知不写死比例 */
        if (cw > 34000) return L("自动压缩：跟随引擎默认 ~" + Math.round((cw - 34000) / cw * 100) + "%", "Auto-compact: engine default, ~" + Math.round((cw - 34000) / cw * 100) + "%");
        return L("自动压缩：跟随引擎默认", "Auto-compact: engine default");
      }
      if (mc.mode === "disabled") return L("自动压缩：已禁用（超窗兜底仍在）", "Auto-compact: disabled (overflow fallback intact)");
      var th = acTargetTokens(mc, cw || 0);
      if (th == null) return L("自动压缩：自定义阈值", "Auto-compact: custom threshold");
      if (th <= 0) return L("自动压缩：自定义阈值（当前窗口未知，无法换算百分比）", "Auto-compact: custom threshold (window size unknown; no percentage)");
      var v = Math.round(th);
      if (cw > 0) return L("自动压缩 ~" + Math.round(v / cw * 100) + "%（" + fmt(v) + " token）", "Auto-compact at ~" + Math.round(v / cw * 100) + "% (" + fmt(v) + " tokens)");
      return L("自动压缩阈值 " + fmt(v) + " token", "Auto-compact threshold " + fmt(v) + " tokens");
    }
    function syncCompactBtn() {
      if (inactive()) return;
      var hcs = [];
      try { hcs = document.querySelectorAll(ZU_HC_SEL); } catch (e) { return; }
      for (var i = 0; i < hcs.length; i++) {
        var body = null, anchor = null;
        try {
          if (!hcs[i].classList.contains("!w-80")) continue;
          if (!hcs[i].querySelector('[data-slot="progress"]')) continue;
          body = hcs[i].querySelector("div.space-y-3");
        } catch (e) { continue; }
        if (!body) continue;
        try {
          for (var j = 0; j < body.children.length; j++) {
            /* 「剩余额度」段=border-t+pt-2（CodingPlanContextUsage/StartPlanContextBalance 的
             * separated 分支）；命中率行在 breakdown 存在时也带 border-t 但是 pt-3，须双类名
             * 判别，否则按钮会插到命中率行上方。 */
            var cls2 = body.children[j].classList;
            if (cls2 && cls2.contains("border-t") && cls2.contains("pt-2")) { anchor = body.children[j]; break; }
          }
        } catch (e) { }
        var exist = null, acInfo = null, acHint = null;
        for (var k = 0; k < body.children.length; k++) {
          var cls3 = body.children[k].classList;
          if (!cls3) continue;
          if (cls3.contains("zu-compact-btn")) exist = body.children[k];
          else if (cls3.contains("zu-ac-info")) acInfo = body.children[k];
          else if (cls3.contains("zu-ac-hint")) acHint = body.children[k];
        }
        /* v200 压缩按钮开关（issue #174）：关闭=摘除已注入按钮（弹层还原原生形态，阈值
         * 行顶到按钮原位）；开启=幂等重挂 + 位置兜回（紧贴「剩余额度」段上方，无则容器尾） */
        if (!state.ctxCpt) {
          if (exist) exist.remove();
          exist = null;
        } else if (exist) {   // 幂等 + 位置兜回：紧贴「剩余额度」段上方（无则容器尾）
          var misplaced = anchor ? exist.nextElementSibling !== anchor : body.lastElementChild !== exist;
          if (misplaced) body.insertBefore(exist, anchor);
        } else {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "zu-compact-btn";
          b.textContent = L("压缩上下文", "Compact context");
          b.addEventListener("click", onCompactClick);
          body.insertBefore(b, anchor);
          exist = b;   // 首挂即回填：阈值行的位置钉靠它，不依赖 querySelector 兜底
        }
        var acRef = exist || anchor;   // v200：按钮在=阈值行钉其上方；按钮关=顶到「剩余额度」段上方
        /* v179 阈值行 → v189 移到压缩按钮上方：文本 + 下划线「调整」链接（点击打开
         * ⚙ 并高亮阈值数值行 3 秒）；v195 下方小字说明行（口径+后果，同生命周期）。
         * 配置变化原地改字（幂等），补丁未生效即摘除。
         * 文本/链接各用 span 按 class 定位更新——整行 textContent 覆盖会抹掉链接。 */
        var infoText = acInfoText(body);
        if (!infoText) { if (acInfo) acInfo.remove(); if (acHint) acHint.remove(); }
        else {
          if (!acInfo) {
            acInfo = document.createElement("div");
            acInfo.className = "zu-ac-info";
            var acText = document.createElement("span");
            acText.className = "zu-ac-text";
            var acLink = document.createElement("span");
            acLink.className = "zu-ac-link";
            acLink.textContent = L("调整", "Adjust");
            /* v198：宿主疑似在 mousedown 即关 hover 卡（click 到来时链接已被摘/穿透，
             * v196/197 实机诊断 acOpen 恒空），改 pointerdown 抢在关闭前响应；
             * click 兜底保留（合成事件与异常路径），面板打开幂等不惧双触发。 */
            acLink.addEventListener("pointerdown", function (e) {
              e.stopPropagation();
              e.preventDefault();
              openAcThresholdSettings();
            });
            acLink.addEventListener("click", function (e) {
              e.stopPropagation();
              e.preventDefault();
              openAcThresholdSettings();
            });
            acInfo.appendChild(acText);
            acInfo.appendChild(acLink);
          }
          var acTextEl = null;
          for (var k2 = 0; k2 < acInfo.children.length; k2++) {
            if (acInfo.children[k2].classList && acInfo.children[k2].classList.contains("zu-ac-text")) { acTextEl = acInfo.children[k2]; break; }
          }
          if (acTextEl && acTextEl.textContent !== infoText) acTextEl.textContent = infoText;
          if (acInfo.nextElementSibling !== acRef) body.insertBefore(acInfo, acRef);   // 钉在压缩按钮上方（按钮关闭时顶到其原位）
          if (!acInfo.__zuRowDelegated) {
            acInfo.__zuRowDelegated = true;
            acInfo.addEventListener("click", function (e) {
              var t = e.target;
              if (t && t.classList && t.classList.contains("zu-ac-link")) openAcThresholdSettings();
            });
          }
          /* v195 新手说明：口径（按窗口总量、与顶部百分比同口径）与后果（自动压缩腾空间），
           * 小字弱化，随阈值行同生命周期；钉在其下、按钮之上。 */
          var hintText = L("按窗口总量计算（与顶部百分比同口径）；走到该比例时，客户端会自动压缩较早的对话内容以腾出空间。", "Measured against the full window (same basis as the percentage above); when reached, earlier conversation is compacted automatically to free up space.");
          if (!acHint) {
            acHint = document.createElement("div");
            acHint.className = "zu-ac-hint";
          }
          if (acHint.textContent !== hintText) acHint.textContent = hintText;
          if (acHint.previousElementSibling !== acInfo || acHint.nextElementSibling !== acRef) body.insertBefore(acHint, acRef);
        }
      }
    }
    /* v189：hover 面板「调整」链接 → 打开 ⚙ 面板并高亮「压缩上下文阈值数值」行 3 秒。
     * 打开复用 gear 点击的完整官方路径（焦点/互斥/高度重测）；分区切换复用导航点击
     * 的关键步骤；高亮计时器实例级归属（dispose 清理）。 */
    function openAcThresholdSettings() {
      if (instanceDisposed) return;
      if (!panel.classList.contains("open")) gear.click();
      if (activeSettingsSec() !== "general") {
        state.settingsSec = "general";
        persist();
        panel.querySelectorAll(".zu-settings-section[data-sec]").forEach(function (s) {
          s.hidden = s.getAttribute("data-sec") !== "general";
        });
        panel.querySelectorAll(".zu-navitem").forEach(function (b) {
          if (b.getAttribute("data-sec") === "general") b.setAttribute("aria-current", "page");
          else b.removeAttribute("aria-current");
        });
        var navBody = panel.querySelector(".zu-settings-body");
        if (navBody) navBody.scrollTop = 0;
        syncSettingsScroll();
      }
      var row = panel.querySelector(".zu-ac-value");
      row = row && row.closest ? row.closest("label") : null;
      if (!row) return;
      try { row.scrollIntoView({ block: "nearest" }); } catch (e) { }
      row.classList.add("zu-ac-flash");
      clearTimeout(acFlashTimer);
      acFlashTimer = setTimeout(function () {
        acFlashTimer = 0;
        try { row.classList.remove("zu-ac-flash"); } catch (e) { }
      }, 3000);
    }
    function closeCompactDlg() {
      if (compactDlgKey) {
        try { document.removeEventListener("keydown", compactDlgKey, true); } catch (e) { }
        compactDlgKey = null;
      }
      if (compactDlg) { try { compactDlg.remove(); } catch (e) { } compactDlg = null; }
      compactAnchor = null; compactFn = null;
    }
    function openCompactDlg(anchorBtn) {
      closeCompactDlg();
      compactAnchor = anchorBtn || null;
      /* fiber 提交函数只在打开瞬间解析（此刻弹层必存活、锚点几何可信）；确认时弹层可能
       * 已被 Radix 卸载（指针移入弹框），届时重解析会退化为「离视口左上角最近」，
       * 多分栏窗口会把 /compact 发进错误 pane 的会话（v110 修复）。 */
      var trig = null, label = "", fn = null;
      try {
        trig = nearestByRect(compactAnchor, ZU_CTX_TRIGGER);
        label = trig ? String(trig.getAttribute("aria-label") || "") : "";
        fn = trig ? fiberPropFrom(trig, "onSendCompressionCommand") : null;
      } catch (e) { }
      compactFn = fn || null;
      var m = label.match(/([\d,，]+)\s*\/\s*总量\s*([\d,，]+)/) || label.match(/([\d,]+)\s+of\s+([\d,]+)/i);
      var dlg = document.createElement("div");
      dlg.className = "zu-compact-dlg";
      var card = document.createElement("div");
      card.className = "zu-compact-card";
      var title = document.createElement("div");
      title.className = "zu-compact-title";
      title.textContent = L("压缩上下文", "Compact context");
      var desc = document.createElement("div");
      desc.className = "zu-compact-desc";
      if (m) {
        var b1 = document.createElement("b");
        b1.textContent = L("当前已用 " + m[1] + " / 总量 " + m[2], "Used " + m[1] + " of " + m[2]);
        desc.appendChild(b1);
        desc.appendChild(document.createTextNode(L("。将把会话历史总结压缩以释放上下文窗口，压缩后上下文占比会回落。", ". The conversation history will be summarized to free context window space; usage drops afterwards.")));
      } else {
        desc.textContent = L("将把会话历史总结压缩以释放上下文窗口，压缩后上下文占比会回落。", "The conversation history will be summarized to free context window space; usage drops afterwards.");
      }
      var hint = document.createElement("div");
      hint.className = "zu-compact-hint";
      hint.textContent = L("压缩通常需要 2-4 分钟且没有进度反馈，期间请勿发送新消息或点停止——那会取消压缩。", "Compaction usually takes 2–4 minutes with no progress indicator. Don't send new messages or stop during it — that cancels it.");
      var err = document.createElement("div");
      err.className = "zu-compact-err";
      var foot = document.createElement("div");
      foot.className = "zu-compact-foot";
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "zu-compact-cancel";
      cancel.textContent = L("取消", "Cancel");
      var ok = document.createElement("button");
      ok.type = "button";
      ok.className = "zu-compact-ok";
      ok.textContent = L("压缩", "Compact");
      cancel.addEventListener("click", closeCompactDlg);
      dlg.addEventListener("mousedown", function (e) {
        if (e.target === dlg) closeCompactDlg();   // 点遮罩关闭（卡片内点击不关）
      });
      ok.addEventListener("click", function () {
        if (ok.disabled) return;
        ok.disabled = true;
        var fail = compactSend(compactAnchor || ok);
        if (fail) {   // 失败：弹框保留并显示中性错误文案，不静默不关闭
          ok.disabled = false;
          err.textContent = fail;
          err.classList.add("on");
          return;
        }
        closeCompactDlg();
      });
      compactDlgKey = function (e) {
        if (!compactDlg) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeCompactDlg();
        } else if (e.key === "Enter" && !ok.disabled) {
          var f = null;
          try { f = document.activeElement; } catch (e2) { }
          if (f && dlg.contains && !dlg.contains(f)) return;   // 焦点已逸出弹框（无焦点陷阱）：不劫持宿主 Enter
          e.preventDefault();
          e.stopPropagation();
          ok.click();
        }
      };
      document.addEventListener("keydown", compactDlgKey, true);   // 捕获先行，拦下宿主对 Esc/Enter 的处理
      foot.appendChild(cancel);
      foot.appendChild(ok);
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(hint);
      card.appendChild(err);
      card.appendChild(foot);
      dlg.appendChild(card);
      document.body.appendChild(dlg);
      compactDlg = dlg;
      try { ok.focus(); } catch (e) { }
    }
    function compactSend(anchorEl) {   // 返回 "" = 已提交；否则错误文案
      /* 主通道（v109 用户指定「直接调发送会话的接口」；v110 改在打开瞬间解析缓存）：
       * fiber 上原生残留的 onSendCompressionCommand——SessionPane 自己的程序化压缩入口，
       * 直接 dispatchCommand("compact") 命令信封，不碰输入框/发送键，流式中也交给引擎
       * 排队。摘要请求非流式（DB 历史 72s-9.6min、典型 2-4 分钟），hint 据此措辞。
       * 兜底：字面 "/compact" 输入提交（E2E 桥 setText+发送键）——流式/发送键/草稿
       * 三重门控全部前置到 setText 之前（拒绝不留残迹），仅当 fiber 通道缺失时使用。 */
      if (compactFn) {
        try { compactFn("/compact"); return ""; } catch (e) { FATAL.cptErr = String((e && e.stack) || e); }
      }
      var input = nearestByRect(anchorEl, '[data-testid="v4-composer-input"]');
      var api = null;
      try { api = input ? input.__zcodeLexicalInputE2E : null; } catch (e) { }
      if (input && api && input.getAttribute("data-e2e-lexical-bridge") === "ready") {
        try {
          if (nearestByRect(anchorEl, '[data-testid="v4-stop"]')) return L("正在生成回复，请等待完成后再压缩", "A reply is being generated; wait for it to finish before compacting");
          var send = nearestByRect(anchorEl, '[data-testid="v4-composer-send"]');
          if (!send || send.disabled) return L("发送键当前不可用（可能正在生成回复）", "Send button is unavailable right now (a reply may be running)");
          var draft = "";
          try { draft = String(api.getText() || ""); } catch (e) { }
          if (draft.replace(/\s+/g, "")) return L("输入框有未发送草稿，请先发送或清空后再压缩", "The composer has an unsent draft; send or clear it before compacting");
          api.setText("/compact");
          send.click();
          return "";
        } catch (e) { FATAL.cptErr = String((e && e.stack) || e); return L("发送失败，请重试", "Send failed; please try again"); }
      }
      return L("未找到可用的提交通道（需 ZCode 桌面端）", "No available submit channel (ZCode desktop required)");
    }
    function onCompactClick(e) {
      if (inactive()) return;   // 停用实例的残留按钮（新代际清扫前的窗口期）无声失效
      e.preventDefault();
      e.stopPropagation();   // 弹层内点击不外泄（Radix/宿主不响应这次 click）
      openCompactDlg(e.currentTarget);
    }

    /* ---------- v80 in-card 挂载：条挂输入卡片内部、group/toolbar 工具行之后自占一行 ----------
     * 宿主 ChatPromptEditor 的工具行是卡片（flex-col gap-3）的最后一个子块；条作为其兄弟
     * 节点插在后面，卡片纯自适应高度自然长高（12px 间距 + 条高），与对话框融为一体。
     * 工具行 Tailwind 类名含 : / [ ] 特殊字符，querySelector 转义易碎 → 按直接子节点
     * className 子串匹配（同 zuDetAnchor 套路）。找不到工具行 = below-card 兜底形态。 */
    function toolbarRowOf(card) {
      try {
        var kids = card.children;
        for (var i = kids.length - 1; i >= 0; i--) {
          if (String(kids[i].className || "").indexOf("group/toolbar") >= 0) return kids[i];
        }
      } catch (e) { }
      return null;
    }
    function mountInCard() {
      var row = cardCache ? toolbarRowOf(cardCache) : null;
      if (!row) return false;
      try {
        if (bar.parentElement !== cardCache) {
          var ref = row.nextSibling;
          if (ref && ref.parentElement === cardCache) cardCache.insertBefore(bar, ref);
          else cardCache.appendChild(bar);
        }
        if (!bar.classList.contains("zu-in")) {
          bar.classList.add("zu-in");
          /* .zu-in 管不住内联声明：摘掉兜底形态写入的悬浮样式与锁宽 */
          bar.style.position = ""; bar.style.zIndex = "";
          bar.style.left = ""; bar.style.top = ""; bar.style.minWidth = ""; bar.style.maxWidth = "";
          lastPos = [-1, -1];
        }
        return true;
      } catch (e) { return false; }
    }
    function mountBelowCard() {   // 兜底还原：无工具行（宿主改版/异形布局）时回到旧悬浮形态
      if (!bar.classList.contains("zu-in") && bar.parentElement === document.body) return;
      bar.classList.remove("zu-in");
      bar.style.position = "fixed"; bar.style.zIndex = "50";
      document.body.appendChild(bar);
      lastPos = [-1, -1];
    }

    /* ---------- 定位：重活低频（找输入框/找卡片），逐帧只做矩形跟随 ---------- */
    var composer = null, cardCache = null, everMounted = false, lastMountDiagAt = 0;
    var curDisplay = "none", lastPos = [-1, -1], hideSince = 0;
    /* v80：true=条挂在输入卡片内部（group/toolbar 工具行之后）；false=旧 below-card 悬浮兜底 */
    var cardMode = false;
    var pillSurface = null, pillObserver = null, pillSyncFrame = 0, pillTransitionTimer = 0;
    var pillTransitions = new Map(), pillParent = null, pillAncestors = [], pillWasHighspeed = false;
    var pillProps = [
      ["backgroundColor", "--zu-pill-bg"],
      ["borderTopWidth", "--zu-pill-border-width"],
      ["borderTopStyle", "--zu-pill-border-style"],
      ["borderTopColor", "--zu-pill-border-color"],
      ["borderRadius", "--zu-pill-radius"]
    ];
    function findPillSurface() {
      if (!composer) return null;
      try {
        var highspeed = composer.closest('[data-highspeed-composer="true"],.highspeed-composer-surface');
        if (highspeed) return highspeed;
      } catch (e) { }
      return cardCache;
    }
    function syncPillSurface() {
      if (inactive() || state.theme !== "pill" || !pillSurface || !pillSurface.isConnected || document.hidden) return;
      try {
        var cs = getComputedStyle(pillSurface);
        for (var i = 0; i < pillProps.length; i++) {
          var value = cs[pillProps[i][0]];
          if (value && bar.style.getPropertyValue(pillProps[i][1]) !== value) bar.style.setProperty(pillProps[i][1], value);
        }
      } catch (e) { }
    }
    function queuePillSurface() {
      if (inactive() || state.theme !== "pill" || pillSyncFrame) return;
      pillSyncFrame = requestAnimationFrame(function () {
        pillSyncFrame = 0;
        prunePillTransitions();
        bindPillSurface();
        ensureCardPad();
        syncPillSurface();
      });
    }
    function prunePillTransitions() {
      pillTransitions.forEach(function (keys, target) {
        if (!composer || !target.isConnected || !target.contains(composer)) pillTransitions.delete(target);
      });
      if (!pillTransitions.size) {
        clearInterval(pillTransitionTimer);
        pillTransitionTimer = 0;
      }
    }
    function onPillTransition(e) {
      if (state.theme !== "pill" || !e.target || !composer) return;
      var key = (e.propertyName || e.animationName || "") + (e.type.indexOf("animation") === 0 ? ":a" : ":t");
      var keys = pillTransitions.get(e.target);
      if (e.type === "transitionrun" || e.type === "animationstart") {
        if (!e.target.contains(composer)) return;
        if (!keys) { keys = new Set(); pillTransitions.set(e.target, keys); }
        keys.add(key);
      } else if (keys) {
        keys.delete(key);
        if (!keys.size) pillTransitions.delete(e.target);
      }
      queuePillSurface();
      if (pillTransitions.size) {
        if (!pillTransitionTimer) pillTransitionTimer = setInterval(queuePillSurface, 80);
      } else {
        clearInterval(pillTransitionTimer);
        pillTransitionTimer = 0;
      }
    }
    function bindPillTransitions() {
      ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"].forEach(function (type) {
        document.addEventListener(type, onPillTransition, true);
      });
    }
    function unbindPillTransitions() {
      ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"].forEach(function (type) {
        document.removeEventListener(type, onPillTransition, true);
      });
      clearInterval(pillTransitionTimer);
      pillTransitionTimer = 0;
      pillTransitions.clear();
    }
    function clearPillSurface() {
      if (pillObserver) pillObserver.disconnect();
      pillObserver = null;
      if (pillSyncFrame) cancelAnimationFrame(pillSyncFrame);
      pillSyncFrame = 0;
      unbindPillTransitions();
      if (pillSurface) {
        ["pointerenter", "pointerleave", "focusin", "focusout"].forEach(function (type) {
          pillSurface.removeEventListener(type, queuePillSurface);
        });
      }
      pillSurface = null;
      pillLayoutAnchor = null;
      pillParent = null;
      pillAncestors = [];
      pillWasHighspeed = false;
      if (bar.style.removeProperty) pillProps.forEach(function (pair) { bar.style.removeProperty(pair[1]); });
    }
    function observePillAncestors() {
      if (!pillObserver || !pillSurface) return;
      var ancestors = [];
      for (var p = pillSurface.parentElement; p && p !== document.body; p = p.parentElement) ancestors.push(p);
      if (pillAncestors && ancestors.length === pillAncestors.length && ancestors.every(function (el, i) { return el === pillAncestors[i]; })) return;
      pillObserver.disconnect();
      pillObserver.observe(pillSurface, { attributes: true, childList: true, subtree: true, attributeFilter: ["class", "style", "data-phase", "data-highspeed-composer"] });
      ancestors.forEach(function (el) {
        pillObserver.observe(el, { attributes: true, childList: !!(el.classList && el.classList.contains("chat-composer-input-surface")), attributeFilter: ["class", "style", "data-highspeed-composer"] });
      });
      pillAncestors = ancestors;
    }
    function onPillMutations(records) {
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (record.type === "childList" && record.target && record.target.classList && record.target.classList.contains("chat-composer-input-surface")) {
          pillLayoutAnchor = pillSurface;
          for (var j = 0; j < record.target.children.length; j++) {
            var child = record.target.children[j];
            if (child.tagName === "P") { pillLayoutAnchor = record.target; break; }
          }
        }
      }
      queuePillSurface();
    }
    function bindPillSurface() {
      var highspeed = null;
      try { if (composer) highspeed = composer.closest('[data-highspeed-composer="true"],.highspeed-composer-surface'); } catch (e) { }
      if (state.theme === "pill" && composer && pillWasHighspeed && !highspeed) {
        var currentCard = composerCardOf(composer);
        if (currentCard && currentCard !== document.body) cardCache = currentCard;
      }
      pillWasHighspeed = !!highspeed;
      var next = state.theme === "pill" ? (highspeed || findPillSurface()) : null;
      pillLayoutAnchor = next;
      if (next && !highspeed) {
        try {
          var inputSurface = next.closest('.chat-composer-input-surface');
          var children = inputSurface && inputSurface.children;
          if (children && children.length && children[children.length - 1].tagName === "P") pillLayoutAnchor = inputSurface;
        } catch (e) { }
      }
      if (next === pillSurface) {
        if (pillSurface && pillParent !== pillSurface.parentElement) {
          unbindPillTransitions();
          bindPillTransitions();
          pillParent = pillSurface.parentElement;
        }
        try { observePillAncestors(); } catch (e) { }
        return;
      }
      var layoutAnchor = pillLayoutAnchor;
      clearPillSurface();
      if (!next) return;
      pillLayoutAnchor = layoutAnchor;
      pillSurface = next;
      pillParent = next.parentElement;
      pillWasHighspeed = !!highspeed;
      bindPillTransitions();
      ["pointerenter", "pointerleave", "focusin", "focusout"].forEach(function (type) {
        pillSurface.addEventListener(type, queuePillSurface);
      });
      try {
        pillObserver = new MutationObserver(onPillMutations);
        pillAncestors = null;
        observePillAncestors();
      } catch (e) { }
      syncPillSurface();
    }
    function applyBarTheme() {
      var pill = state.theme === "pill", compact = state.theme === "compact";
      bar.setAttribute("data-zusage-theme", state.theme);
      bar.classList.toggle("zu-pill", pill);
      bar.classList.toggle("zu-compact", compact);
      /* v226 水平对齐类只在默认档存在（药丸恒 flex-start、精简条不可见），切档即摘；
       * ⚙ 面板对齐设置块随档显隐（面板高度契约只收紧不放大，重现时转为内容区滚动） */
      var just = state.theme === "default" ? state.barJust : "between";
      bar.classList.toggle("zu-just-start", just === "start");
      bar.classList.toggle("zu-just-end", just === "end");
      var justBlock = panel.querySelector(".zu-just-block");
      if (justBlock) justBlock.style.display = state.theme === "default" ? "" : "none";
      tip.classList.toggle("zu-pill-skin", pill);
      panel.querySelectorAll('.zu-theme-choice').forEach(function (r) { r.checked = state.theme === r.value; });
      if (compact) {
        /* v146 精简模式：条永久隐藏（display:none），样式表/ariaLive 随条保留（<style> 挂条内
         * 但作用域全局，隐藏不影响 chip 样式生效）；条挪到 body 脱离卡片，React 清卡片子树
         * 时不牵连。chips 照常由 enhance 系列/syncTpsChip 在 render/heavy 维护。 */
        clearPillSurface();
        cardMode = false;
        if (!bar.isConnected || bar.parentElement !== document.body) document.body.appendChild(bar);
        if (curDisplay !== "none") { bar.style.display = "none"; curDisplay = "none"; }
        compactHid = true;
        bar.style.minWidth = "";
        bar.style.maxWidth = "";
        bar.style.visibility = "";   // pillUnsafe 遗留隐藏一并还原（写入点仅 pill 分支，防御切档路径）
        releasePads();
        hideTip(true, "compact-theme");   // 条面 tooltip 的宿主格子已不存在，强制收起
      } else if (pill) {
        cardMode = false;
        mountBelowCard();
        bar.style.minWidth = "";
        bindPillSurface();
        ensureCardPad();
      } else {
        clearPillSurface();
        main.scrollLeft = 0;
        bar.style.maxWidth = "";
        bar.style.visibility = "";   /* pillUnsafe 的安全隐藏是 pill 专属态（写入点仅 track 的 pill 分支），切回默认必须还原，否则条永久不可见 */
        if (composer) {
          var normalCard = composerCardOf(composer);
          if (normalCard && normalCard !== document.body) cardCache = normalCard;
        }
        if (cardCache) {
          cardMode = mountInCard();
          if (cardMode) releasePads();
          else { mountBelowCard(); ensureCardPad(); }
        }
      }
      if (state.theme !== "compact") {
        restoreTpsChip();   // v146：离开精简档立即摘工具行速率 chip（精简内由 render/heavy 重挂）
        /* v156：离开精简立即恢复显示（display:none 是 compact 专属态，不留到下一帧）并
         * 强制条面重建一次——compact 期 render 跳过 innerHTML，若条面 DOM 因热更占位/清子树
         * 处于空壳，签名相等会让空壳一直存活（用户实测：精简→默认后工具行下残留一条细线，
         * 数十秒后随数据变化才消失）。compactHid 区分初载 none：初载不提前露条（pill 定位
         * 契约依赖首帧前条不可见）。 */
        if (compactHid) {
          if (curDisplay !== "flex") { bar.style.display = "flex"; curDisplay = "flex"; }
          lastHtml = "";
          compactHid = false;
        }
      }
      shrink = 0;
      render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 });
      positionSettingsPanel();
    }

    function findDetRoot() {
      /* v174：会话根（最近 data-session-id 祖先）——确定性统计行按它判定归属实例，
       * 辅助对话与主分栏并存时同名 turn 不串 tracker。 */
      for (var p = composer; p && p !== document.body; p = p.parentElement) {
        if (p.hasAttribute && p.hasAttribute("data-session-id")) return p;
      }
      return null;
    }
    function setComposer(el) {
      cancelGitRefresh();
      clearPillSurface();
      releasePads();   // 旧卡片的让位边距先还原（in-card 形态不需要让位带；兜底形态由 heavy 补回）
      composer = el;
      cardCache = null;
      cardMode = false;
      detRootEl = el ? findDetRoot() : null;
      if (composer) {
        var c = composerCardOf(composer);
        if (c && c !== document.body) cardCache = c;
      }
      if (bar.classList.contains("zu-in")) mountBelowCard();   // 换卡先回落兜底形态，heavy 同 tick 重判挂载
    }
    function heavy() {
      if (inactive()) return;
      if (pid === "auto") {
        /* 兜底模式（主文档找不到带 pane 标记的输入框，shadow/iframe 场景）：沿用原
         * 单条查找链路（findComposer 含 deepFind 穿透），会话判定走 mine/pickCurrent */
        var el = wantedEl && wantedEl.isConnected ? wantedEl : findComposer();
        if (el && el !== composer) setComposer(el);
        else if (!el && composer && !composer.isConnected) setComposer(null);
        else if (el && el === composer && (!detRootEl || !detRootEl.isConnected)) detRootEl = findDetRoot();   // v177：同款窗口期补算
      } else {
        /* v61.1 多实例：composer 由协调器按 pane 派发（wantedEl），本层只对账——
         * 元素被 React 重建/pane 关闭时清绑，等下一轮协调器重新派发 */
        if (wantedEl && wantedEl.isConnected) {
          if (wantedEl !== composer) setComposer(wantedEl);
          /* v177：窗口期补算——setComposer 落在宿主「composer 已挂、data-session-id 未写」
           * 窗口时 detRootEl 为 null 且元素引用不变不再重进 setComposer，宿主补写属性后
           * det 统计行/富文本归属链会持续失效；这里按拍补算一次自愈。 */
          else if (!detRootEl || !detRootEl.isConnected) detRootEl = findDetRoot();
        } else if (composer) {
          setComposer(null);
        }
        var nextScope = readPaneScope(wantedEl, pendingSid, pid);
        var nextScopeStamp = JSON.stringify(nextScope);
        if (pendingSid !== instSid || nextScopeStamp !== scopeStamp) {
          cancelGitRefresh();
          instSid = pendingSid;
          scopeStamp = nextScopeStamp;
          /* v262：state.data 尚未就位（空渲染不再污染共享数据）时也按当前会话空渲染一遍
           * ——pickedSid/refreshWants（Git 首查路径上报）都依赖 render 跑一遍，旧行为靠
           * 被污染的 state.data（EMPTY 非 null）侥幸驱动，条件写后必须显式兜住。 */
          if (state.data || instSid) render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 });
          refreshWants();
        }
      }
      if (!composer && slot === 0) collectDiag();   // 一直找不到输入框的窗口：周期性写环境诊断（everMounted 门防覆盖）
      if (state.theme === "compact") {
        /* v146 精简模式：条常驻 body 且 display:none——挂载/几何/让位带全部停用。唯一职责
         * 是保条存活（chip 样式 <style> 与 ariaLive 随条，React 清 body 子树时补挂），
         * cardCache 照常维护（chips 的宿主查询面），让位带还原。 */
        if (!bar.isConnected || bar.parentElement !== document.body) document.body.appendChild(bar);
        if (curDisplay !== "none") { bar.style.display = "none"; curDisplay = "none"; }
        releasePads();
        cardMode = false;
      }
      if (composer) {
        if (!cardCache || !cardCache.isConnected) {
          var c = composerCardOf(composer);
          cardCache = c && c !== document.body ? c : null;
        }
        if (state.theme !== "pill" && composer.getAttribute && composer.getAttribute("data-testid") === "v4-composer-input") {
          var liveCard = composerCardOf(composer);
          if (liveCard && liveCard !== cardCache && liveCard !== document.body) cardCache = liveCard;
        }
        if (state.theme === "compact") {
          if (cardCache) nativeCtxVal = readNativeCtx(cardCache);   // v146：上下文窗口自动识别的备源照常刷新
        } else if (cardCache) {
          /* v80：优先挂输入卡片内部（工具行下）；无工具行回落 below-card 兜底 + 让位带 */
          cardMode = state.theme !== "pill" && mountInCard();
          if (state.theme === "pill") { bindPillSurface(); syncPillSurface(); }
          if (cardMode) releasePads();
          else { mountBelowCard(); ensureCardPad(); }   // React 重渲染可能重建卡片/重置内联边距，对比后再补
          nativeCtxVal = readNativeCtx(cardCache);
        } else if (cardMode) {
          mountBelowCard();
        }
      }
      enhanceCtxButton();   // v92：DOM 对账点（React 重渲染/按钮重建后兜回，幂等）
      enhanceQuotaChip();   // v96：额度 chip DOM 对账点（按钮重建/前插节点被挤走后兜回）
      enhanceModelPuller();   // v132：宿主设置页按钮 DOM 对账点（进设置页/React 重建后兜回，幂等）
      enhanceGitChip();     // v96：同点对账（React 重建工具行后重挂/位置兜回/紧凑态切换）
      syncTpsChip();        // v146：速率 chip DOM 对账点（React 重建工具行/位置挤走后兜回；非精简主题内部门控摘除）
      syncCompactBtn();     // v105：弹层压缩按钮对账点（Observer 漏触发/节点移位后兜回）
      dedupBars();          // v169：同容器双条去重（Windows 最小化/还原双条，用户报告）
      if (state.data && pid === "auto") {
        var msid = typeof state.data.mine === "string" ? state.data.mine : null;
        var pSid;
        if (msid !== null) pSid = msid;   // mine 模式：泵会在会话切换时推新 payload，这里只需同步 pickedSid
        else {
          var pc = pickCurrent(state.data);
          pSid = pc ? (pc.sess ? pc.sess.sid : pc.want) : "";
        }
        if (pSid !== pickedSid) render(state.data);   // 切换了会话：立即按缓存 payload 重渲染
      }
    }
    /* v169 同容器双条去重（Windows 最小化/还原双条，用户报告）：窗口状态切换时宿主可能
     * 短暂保留旧视图副本/重建编辑框，协调器按 pane 键派发可能短暂出现两个实例、两根条
     * 落进同一张卡（或同为 body 兜底且矩形重叠）。规则：同一容器内可见 .zusage-root >1、
     * 或两根 body 兜底条矩形重叠过半时，data-zusage-slot 大的一根让位（hideBar 抑制，
     * 对手消失后自动解除）。拆分窗格各卡各条不受影响（按容器判定）。 */
    var dupSuppress = false;
    function barVisible(b) {
      if (!b || !b.isConnected) return false;
      var st = b.style;
      if (st.display === "none" || st.visibility === "hidden") return false;
      try { var cs = getComputedStyle(b); if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return false; } catch (e) { }
      var r = b.getBoundingClientRect();
      return r.width > 40 && r.height > 8;
    }
    function barSlot(b) { var v = parseInt(b.getAttribute && b.getAttribute("data-zusage-slot"), 10); return isNaN(v) ? 99 : v; }
    function dedupBars() {
      if (state.theme === "compact") { if (dupSuppress) { dupSuppress = false; } return; }
      var rival = null;
      try {
        var bars = [];
        if (cardCache) {
          var kids = cardCache.querySelectorAll(".zusage-root");
          for (var i = 0; i < kids.length; i++) if (kids[i] !== bar && kids[i].isConnected) bars.push(kids[i]);
        }
        if (bar.parentElement === document.body) {
          document.querySelectorAll("body > .zusage-root").forEach(function (b) { if (b !== bar) bars.push(b); });
        }
        for (var j = 0; j < bars.length; j++) {
          var b = bars[j];
          var sameCard = cardCache && b.parentElement === cardCache;
          if (!sameCard && bar.parentElement === document.body) {
            var r1 = bar.getBoundingClientRect(), r2 = b.getBoundingClientRect();
            var ix = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left));
            var iy = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
            if (!(ix * iy > 0.5 * r1.width * r1.height && r2.height > 8)) continue;
          } else if (!sameCard) { continue; }
          if (barVisible(b)) { if (!rival || barSlot(b) < barSlot(rival)) rival = b; }   // 只被「可见的」对手压制；隐藏对手不构成冲突
        }
      } catch (e) { }
      if (rival && barSlot(rival) < barSlot(bar)) {
        if (!dupSuppress) { dupSuppress = true; hideBar(); }
        return;
      }
      dupSuppress = false;
    }
    function hideBar() {
      if (curDisplay !== "none") { bar.style.display = "none"; curDisplay = "none"; }
      /* v80：面板挂 body 不再随条隐藏，条隐时必须主动收起（否则面板悬空在已消失的条上方） */
      if (panel.classList.contains("open")) closeSettings(false);
      if (subPopOpen()) subPopClose(false, "bar-hidden");
      hideTip(true, "bar-hidden");   // 条面整体隐藏时 tooltip 必须跟着走（force 绕过总闸）
    }
    /* 超限气泡同步（track 每帧调）：位置贴条上沿、左缘对齐；条隐藏/超限解除/已关闭则藏。
     * exc 解除时复位 excGone，下次再超限会重新弹。display 切换与测量在同一同步块内
     * 完成后才绘制，无首帧闪位。 */
    function syncExcBubble() {
      var show = excOn && !excGone && curDisplay === "flex";
      if (!show) {
        if (!excOn) excGone = false;
        if (excBubble.style.display !== "none") excBubble.style.display = "none";
        return;
      }
      var sidStr = pickedSid || L("（未知）", "(unknown)");
      if (excSid.textContent !== sidStr) excSid.textContent = sidStr;
      if (excBubble.style.display !== "block") excBubble.style.display = "block";
      var br = bar.getBoundingClientRect();
      var r = excBubble.getBoundingClientRect();
      var left = Math.max(8, Math.round(Math.min(br.left, innerWidth - r.width - 8)));
      var top = Math.max(8, Math.round(br.top - r.height - 8));
      if (excBubble.style.left !== left + "px") excBubble.style.left = left + "px";
      if (excBubble.style.top !== top + "px") excBubble.style.top = top + "px";
    }
    /* 可见性判定（带卡片豁免）：输入框视觉卡片内部的装饰层（占位符/镜像/焦点层等）
     * 瞬时盖到输入框中心不算"被盖住"——逐帧严格判定会造成显示/隐藏来回横跳（闪烁）；
     * 设置页等真正的覆盖层不在卡片内，仍判为盖住。
     * 条外挂在输入框上方，不参与对输入框中心的遮挡（v12-v14 内嵌形态的自遮挡闪烁根因）。 */
    function coverOK(el) {
      var r = el.getBoundingClientRect();
      var rectKey = r.left + "," + r.top + "," + r.width + "," + r.height;
      var now = Date.now(), ch = coverCache.get(el);
      if (ch && ch.key === "c" && ch.rect === rectKey && now - ch.at < COVER_TTL) return ch.val;
      var val = cardHitOK(el, r);
      coverCache.set(el, { key: "c", rect: rectKey, val: val, at: now });
      return val;
    }
    function cardHitOK(el, r) {
      var hit;
      try { hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) { return true; }
      if (!hit) return false;
      if (hit === el || hit.contains(el) || el.contains(hit)) return true;
      if (cardCache && cardCache.contains(el) && cardCache.contains(hit)) return true;
      if (isOwnOverlay(hit)) return true;   // 自己的面板/气泡盖住输入框中心不算被盖（v40）
      return false;
    }
    /* 隐藏态诊断（v61）：条被判定不可见时周期性转储现场 —— body 直接子层的矩形/
     * pointer-events/透明度、elementFromPoint 命中链、幽灵子树判定与 body 的 pe 状态。
     * 定位"正常聊天窗口被误藏"类问题用；节流 4s，只写 __zusageDiag.hidden
     * （泵取回写 diag-<n>.json）。 */
    var lastHiddenDiagAt = 0;
    function elDesc(el) {
      if (!el) return String(el);
      var cls = el instanceof Element ? (el.getAttribute("class") || "") : "";
      return el.tagName + (el.id ? "#" + el.id : "") + (cls ? "." + String(cls).slice(0, 60) : "");
    }
    function diagHidden(r) {
      var now = Date.now();
      if (now - lastHiddenDiagAt < 4000) return;
      lastHiddenDiagAt = now;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var hit = null, chain = [], bodyPE = "";
      try {
        hit = document.elementFromPoint(cx, cy);
        chain = (document.elementsFromPoint(cx, cy) || []).slice(0, 8).map(elDesc);
        bodyPE = getComputedStyle(document.body).pointerEvents;
      } catch (e) { }
      var kids = [];
      try {
        var cs = document.body.children;
        for (var i = 0; i < cs.length; i++) {
          var el = cs[i], kr = el.getBoundingClientRect(), st = getComputedStyle(el);
          kids.push({
            el: elDesc(el),
            rect: [Math.round(kr.left), Math.round(kr.top), Math.round(kr.width), Math.round(kr.height)],
            pe: st.pointerEvents, op: st.opacity, vis: st.visibility, disp: st.display,
            covers: (kr.width >= 4 && kr.height >= 4 && cx >= kr.left && cx <= kr.right && cy >= kr.top && cy <= kr.bottom) ? 1 : 0,
          });
        }
      } catch (e) { }
      FATAL.hidden = {
        time: new Date().toISOString(),
        ghost: inGhostSubtree(composer),
        modal: modalOpen(),   // v62：模态弹窗判定（弹窗打开时条本就该收起，用于区分"误藏"与"应藏"）
        bodyPE: bodyPE,
        hit: elDesc(hit),
        chain: chain,
        composerCenter: [Math.round(cx), Math.round(cy)],
        composerRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        bodyKids: kids,
      };
    }
    /* 分屏现场诊断（v61）：转储全部可见 textarea 的祖先链（含 data-* 属性）、全页
     * iframe 的矩形与 src、pane/layout 相关 localStorage 键——用于确认"pane → 工作区/
     * 会话"能否从 DOM 映射（多实例状态条的数据源设计依据）。随 mount 诊断每 5s 刷新。 */
    function diagPanes() {
      try {
        var composers = [];
        document.querySelectorAll(COMPOSER_SEL + ",textarea").forEach(function (ta) {
          if (!visible(ta)) return;
          var r = ta.getBoundingClientRect();
          if (r.top < innerHeight * 0.4) return;
          var sess = null, pane = null, tag = elDesc(ta);
          for (var p = ta; p && p !== document.body; p = p.parentElement) {
            if (sess === null && p.hasAttribute && p.hasAttribute("data-session-id")) sess = p.getAttribute("data-session-id");
            if (pane === null && p.hasAttribute && p.hasAttribute("data-pane-id")) pane = p.getAttribute("data-pane-id");
          }
          composers.push({ tag: tag, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], pane: pane, sess: sess });
        });
        var webviews = [];
        document.querySelectorAll("webview,iframe").forEach(function (fr) {
          var r = fr.getBoundingClientRect();
          webviews.push({ tag: fr.tagName, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], src: String(fr.src || "").slice(0, 130) });
        });
        var attrHits = [];
        document.querySelectorAll("[data-session],[data-session-id],[data-workspace],[data-workspace-path],[data-pane],[data-pane-id],[data-task-id]").forEach(function (el) {
          var parts = [el.tagName];
          for (var i = 0; i < el.attributes.length; i++) {
            var a = el.attributes[i];
            if (/^data-(session|workspace|pane|task)/i.test(a.name)) parts.push(a.name + "=" + String(a.value).slice(0, 60));
          }
          attrHits.push(parts.join(" "));
        });
        var lsPane = [];
        try {
          Object.keys(localStorage).forEach(function (k) {
            if (/pane|split|layout|last-session/i.test(k)) lsPane.push(k + " = " + String(localStorage.getItem(k)).slice(0, 160));
          });
        } catch (e) { }
        FATAL.panes = { time: new Date().toISOString(), composers: composers, webviews: webviews.slice(0, 10), attrHits: attrHits.slice(0, 30), lsPane: lsPane.slice(0, 20) };
      } catch (e) { FATAL.panes = { err: String((e && e.stack) || e) }; }
    }

    function track() {
      if (inactive()) return;   // 旧实例罢工，把舞台让给新实例
      try {
        /* v115：窗口不可见（最小化/被遮挡）时整帧跳过——渲染无意义；rAF 在多数后台形态
         * 已停发，这里兜住仍派帧的平台/形态，恢复可见后自调度自然续上并由下一帧重判。 */
        if (document.hidden) return;
        syncExcBubble();   // 超限气泡：显示/隐藏/贴条定位（内部自判状态，隐藏分支零开销）
        if (!composer || !composer.isConnected) { hideSince = 0; hideBar(); return; }
        if (state.theme === "compact") {
          /* v146 精简模式：条已 display:none，几何/显隐/收缩全部停用（超限气泡由
           * syncExcBubble 的 curDisplay 门自兜隐藏）；面板周期跟随与诊断保留，帧循环自续。 */
          everMounted = true;
          positionSettingsPanel();   // v155：compact 早退前补两面板的逐帧跟随（内部 open 门，关闭零开销）
          positionSubPop();
          if (slot === 0 && Date.now() - lastMountDiagAt > 5000) {
            lastMountDiagAt = Date.now();
            FATAL.mount = {
              version: VERSION, mode: "compact", theme: themeDark ? "dark" : "light", picked: pickedSid,
              tpsChip: !!(tpsChipCache && tpsChipCache.isConnected),
              quotaChip: !!(quotaChipCache && quotaChipCache.isConnected),
              gitChip: !!(gitChipCache && gitChipCache.isConnected)
            };
          }
          return;
        }
        if (cardMode) {
          /* v80 in-card 对账：React 整子树重挂（切会话 key 变化）会连外来节点一起丢，
           * 帧率级检查补挂；卡片本身被重建时 cardCache 断连，heavy 低频重找后再挂 */
          if (!bar.isConnected || bar.parentElement !== cardCache) {
            cardMode = mountInCard();
            if (!cardMode) mountBelowCard();
          }
        } else if (cardCache && (state.theme === "pill" || !paddedCard || paddedCard.style.marginBottom !== CARD_MARGIN)) {
          ensureCardPad();   // 流式期间 React 重置内联边距时立刻补回（仅 below-card 兜底形态）
        }
        var r = composer.getBoundingClientRect();
        var on = r.width > 60 && r.height > 14 && r.bottom > 0 && r.top < innerHeight &&
          !ghostOf(composer) &&          // 设置页等幽灵壳（opacity-0/inert）：视觉已隐藏（v61，v115 TTL 缓存）
          !inSettingsView(composer) &&   // v91：设置页排除的第四处收口——已绑到设置页编辑框时不显示（防其它绑定路径漏排除）
          !modalOpenCached() &&          // v62：模态弹窗（模型配置等）打开时整体收起，弹窗内容不归条管（issue #9；v115 TTL 缓存）
          (reallyVisible(composer, true) || coverOK(composer));
        if (!on) {
          if (slot === 0) diagHidden(r);   // 隐藏现场周期转储（v61，节流 4s；仅 0 号实例写，槽位共享）
          // 迟滞：连续 400ms 判定不可见才隐藏，瞬时失败（流式装饰层等）不闪
          if (!hideSince) hideSince = Date.now();
          if (Date.now() - hideSince > 400) { hideBar(); }
          return;
        }
        hideSince = 0;
        /* v177：让位抑制期间不得复显——dedupBars 只在 heavy（600ms）里锁 dupSuppress，
         * track 每帧无条件复显会把抑制打穿（首帧隐藏、次帧复显，此后 heavy 因已锁不再隐藏
         * = 双条永久并存，Windows 最小化/还原场景失效）。复显在 heavy 解除抑制后的下一帧发生。 */
        if (!dupSuppress && curDisplay !== "flex") { bar.style.display = "flex"; curDisplay = "flex"; }
        if (state.theme === "pill") {
          ensureCardPad();
          adjustPillBottom();
          /* 不安全（无法让位且会盖住输入区）时不整条 display 切换：visibility 隐藏保持
           * offsetHeight 可测，几何/布局恢复后下一帧自动复显，无每帧显隐抖动。 */
          var wantVisibility = pillUnsafe ? "hidden" : "";
          if (bar.style.visibility !== wantVisibility) bar.style.visibility = wantVisibility;
        }
        /* 悬浮在输入框视觉卡片正下方（v58 定位回归）：v55-v57 改贴窗口底，新对话 hero 页
         * 输入框垂直居中时条与输入框彻底脱钩（用户点名回退）。让位带 24px 比条高+顶缝
         * 短 ~7px，条底落进原生底部留白、距窗口底 ~7px —— v54 的"条下 15px 空白"不复发。
         * 水平仍与卡片左缘对齐 */
        var anchor = (state.theme === "pill" && (pillLayoutAnchor || pillSurface)) || cardCache || composer;
        var ar = anchor.getBoundingClientRect();
        if (!cardMode) {
          /* 悬浮在输入框视觉卡片正下方（v58 定位回归）：v55-v57 改贴窗口底，新对话 hero 页
           * 输入框垂直居中时条与输入框彻底脱钩（用户点名回退）。让位带 24px 比条高+顶缝
           * 短 ~7px，条底落进原生底部留白、距窗口底 ~7px —— v54 的"条下 15px 空白"不复发。
           * 水平仍与卡片左缘对齐。v80 起仅 below-card 兜底形态走这里。 */
          var left = Math.round(ar.left);
          /* 药丸与卡片底边间距 8px、距窗口底 8px（用户规格 2026-10-29）；默认兜底形态维持 4px/2px。 */
          var pillGap = state.theme === "pill" ? 8 : 4;
          var bottomGap = state.theme === "pill" ? 8 : 2;
          var bottomLimit = state.theme === "pill" && pillBottomLimit !== null ? pillBottomLimit : innerHeight;
          var top = Math.max(8, Math.min(Math.round(ar.bottom + pillGap), bottomLimit - bar.offsetHeight - bottomGap));
          if (state.theme === "pill") {
            var available = Math.max(0, Math.min(ar.width, innerWidth - 16));
            var maxW = Math.round(available) + "px";
            if (bar.style.minWidth) bar.style.minWidth = "";
            if (bar.style.maxWidth !== maxW) bar.style.maxWidth = maxW;
            var width = bar.getBoundingClientRect().width;
            left = Math.max(8, Math.min(Math.round(ar.left + (ar.width - width) / 2), Math.round(innerWidth - width - 8)));
          } else {
            /* 宽度锁死卡片（v63 对齐，v66 收缩）：min=max-width = 卡片实测宽。 */
            var minW = Math.max(60, Math.round(ar.width));
            if (bar.style.minWidth !== minW + "px") bar.style.minWidth = minW + "px";
            if (bar.style.maxWidth !== minW + "px") bar.style.maxWidth = minW + "px";
          }
          if (left !== lastPos[0] || top !== lastPos[1]) {
            bar.style.left = left + "px"; bar.style.top = top + "px";
            lastPos = [left, top];
          }
        }
        /* in-card 形态（v80）：无坐标跟随、无锁宽——宽度由卡片 flex-col 的 stretch 撑满内宽。
         * 两种形态共用的收缩判定：内容超宽不撑破卡片，分级收缩：先隐藏「本轮/会话累计」
         * 的缓存命中率（核心项 tps/上下文/会话累计不动，明细仍在悬停 tooltip），
         * 迟滞 +12px/-120px 防数值刷新在阈值附近来回闪；仍装不下由 .zu-main 右缘渐隐
         * 兜底（.zu-clip）。测量基准都是 bar 自身内容宽，形态无关。 */
        var ov = main.scrollWidth - main.clientWidth;
        var ns = shrink;
        if (!shrink && ov > 12) ns = 1;
        else if (shrink && ov < -120) ns = 0;
        if (ns !== shrink) { shrink = ns; render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 }); }
        var clip = state.theme !== "pill" && main.scrollWidth > main.clientWidth + 1;
        if (clip !== fadeOn) { fadeOn = clip; main.classList.toggle("zu-clip", clip); }
        positionSettingsPanel();
        positionSubPop();
        everMounted = true;
        if (slot === 0 && Date.now() - lastMountDiagAt > 5000) {
          lastMountDiagAt = Date.now();
          var br = bar.getBoundingClientRect(), bh = null;
          try { bh = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); } catch (e) { }
          FATAL.mount = {
            version: VERSION, mode: cardMode ? "in-card" : "below-card", bodyPE: (function () { try { return getComputedStyle(document.body).pointerEvents; } catch (e) { return ""; } })(),
            panes: diagPanes(),
            theme: themeDark ? "dark" : "light",
            /* 字体跟随（v64）实测：条面计算字体 + 客户端两个字体变量的原值（验证 var 命中） */
            font: (function () {
              try {
                var rs = getComputedStyle(document.documentElement), cs = getComputedStyle(bar);
                return { fam: String(cs.fontFamily).slice(0, 90), size: cs.fontSize,
                  mono: String(rs.getPropertyValue("--font-mono")).slice(0, 80).trim(),
                  ui: String(rs.getPropertyValue("--ui-font-size")).trim() };
              } catch (e) { return "ERR:" + e; }
            })(),
            tip: (function () { return { stats: tipStats, disp: tip.style.display, barRect: (function () { var b = bar.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })() }; })(),
            composerRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            anchorRect: [Math.round(ar.left), Math.round(ar.top), Math.round(ar.width), Math.round(ar.height)],
            barRect: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)],
            /* 条中心命中元素：若被应用层盖住（z 序问题）此处直接暴露 */
            barHit: bh ? bh.tagName + "." + String(bh.className).slice(0, 40) : String(bh),
            bottomGap: Math.round(innerHeight - ar.bottom),
            nativeCtx: nativeCtxVal,
            quota: { providerId: effectiveQuotaProvider(), modelId: quotaModel, sourceId: quotaSourceId,
              selected: !!quotaSelection, status: lastQuota ? lastQuota.status : "unavailable", chip: !!quotaChipCache },
            picked: pickedSid,
            exc: excOn ? (excGone ? "on-gone" : "on") : 0,
            href: String(location.href).slice(0, 120),
            lsVals: (function () {
              try {
                var out = [];
                Object.keys(localStorage).forEach(function (k) {
                  /* 只转储本插件命名空间：宿主 localStorage 可能存任意键值（含会话/令牌类
                   * 数据），诊断文件不该整库带走（2026-10-24 审计 O9）。 */
                  if (String(k).indexOf("zusage") !== 0) return;
                  out.push(k + " = " + String(localStorage.getItem(k)).slice(0, 90));
                });
                var wk = [];
                Object.keys(window).forEach(function (k) {
                  if (/zcode|session|store|state|tab/i.test(k)) wk.push(k);
                });
                out.push("WINDOW_KEYS=" + wk.join("|").slice(0, 300));
                return out.join("\n").slice(0, 7000) || "(none)";
              } catch (e) { return "ERR:" + e; }
            })(),
            lastSessionVals: (function () {
              try {
                var out = [];
                Object.keys(localStorage).forEach(function (k) {
                  if (/last-session/i.test(k)) out.push(k.slice(22) + "=" + String(localStorage.getItem(k)).slice(0, 50));
                });
                return out.join(" | ").slice(0, 1000) || "(none)";
              } catch (e) { return "ERR:" + e; }
            })(),
          };
        }
      } catch (e) {
        if (Date.now() - (track.errAt || 0) > 5000) {
          track.errAt = Date.now();
          FATAL.trackErr = String((e && e.stack) || e);
        }
      } finally {
        if (!inactive()) frame = requestAnimationFrame(track);   // 自调度循环：异常绝不能杀死循环（setInterval 无此问题，rAF 有）
      }
    }

    heavyTimer = setInterval(heavy, 600);
    heavy();
    frame = requestAnimationFrame(track);
    /* v105：弹层压缩按钮的即时重注入观察器。弹层每次打开/关闭都是 body 子树变异，rAF 去抖
     * 合并同帧爆发；自身注入也会触发下一轮回查（存在性幂等，无环）。异常只降级为 heavy 兜底。 */
    var hcObserver = null, hcObsQueued = false;
    try {
      hcObserver = new MutationObserver(function () {
        if (state.theme === "pill" && pillSurface && pillSurface.parentElement !== pillParent) queuePillSurface();
        if (hcObsQueued) return;
        hcObsQueued = true;
        requestAnimationFrame(function () {
          hcObsQueued = false;
          syncCompactBtn();
        });
      });
      hcObserver.observe(document.body, { childList: true, subtree: true });
    } catch (e) { FATAL.cptErr = String(e); }

    syncPanel();
    if (state.data) render(state.data);   // 已有共享数据（后 spawn 的实例）直接渲染，不用零值覆盖
    else render({ session: {}, last_turn: {}, today: {}, context_window: 0 });

    function dispose() {
      if (instanceDisposed) return;
      instanceDisposed = true;
      clearInterval(heavyTimer);
      /* v275：待合并重编的 rAF 一并取消 */
      if (speedRebuildPending && typeof cancelAnimationFrame === "function") { cancelAnimationFrame(speedRebuildPending); speedRebuildPending = 0; }
      clearInterval(bridge.timer);   // v71：pane 销毁即停能力检测并释放 store 订阅
      clearInterval(subRateTimer);   // v97：子代理面板速率刷新定时器
      subRateTimer = 0;
      subPopMode = "closed"; subPopEntry = null; subPopSig = "";   // v217：浮层态随实例销毁复位
      if (subPopHideTimer) { clearTimeout(subPopHideTimer); subPopHideTimer = 0; }
      /* v244：重启请求在途的两路还原定时器随实例销毁（热重载后旧实例闭包不留 90s 滞留） */
      if (relaunchAckTimer) { clearTimeout(relaunchAckTimer); relaunchAckTimer = 0; }
      if (relaunchAliveTimer) { clearTimeout(relaunchAliveTimer); relaunchAliveTimer = 0; }
      bridgeDetach(bridge.handle);
      cancelAnimationFrame(frame);
      cancelTipGrace();
      if (excCopied) clearTimeout(excCopied.timer);
      if (themeObserver) themeObserver.disconnect();
      clearPillSurface();
      if (quotaSelectionObserver) quotaSelectionObserver.disconnect();
      quotaSelectionObserver = null; quotaPaneRoot = null; quotaSelection = null;
      if (hcObserver) hcObserver.disconnect();   // v105：停弹层压缩按钮观察器
      clearTimeout(acFlashTimer); acFlashTimer = 0;   // v189：阈值行高亮计时器随实例销毁
      closeCompactDlg();   // v105：本实例打开的确认弹框与 Esc/Enter 监听一并摘除
      cleanupMpModal();   // v130：本实例打开的模型拉取弹窗与 Esc 监听一并摘除（body 级 DOM 不随 pane 走）
      restoreModelPuller();   // v132：pane 关闭后同步摘除宿主设置页按钮（其余实例的 enhance 会重建）
      globalListeners.forEach(function (binding) {
        binding[0].removeEventListener(binding[1], binding[2], binding[3]);
      });
      globalListeners = [];
      releasePads();
      if (ctxBtnCache) { restoreCtxButton(ctxBtnCache); ctxBtnCache = null; }   // v92：还原原生按钮形态
      restoreQuotaChip();   // v95：摘除额度 chip（不留孤儿节点）
      restoreTpsChip();   // v146：摘除精简模式速率 chip（含在显 tooltip）
      restoreGitChip();   // v96：摘掉本 pane 的 Git chip（含在显 tooltip）
      /* v180 review：行内速率 chip 挂在宿主 Agent 行内（非条面自家节点），dispose
       * 不摘会在 pane 输入框暂时不可见被协调器回收时冻结在旧速率上、悬停还弹出
       * 已 dispose 实例的 tooltip——趁 wantedEl/composer 尚在按 pane 根摘净。 */
      try {
        var srr = subRowPaneRoot();
        if (srr) {
          var staleChips = srr.querySelectorAll(".zu-subrate");
          for (var sc = 0; sc < staleChips.length; sc++) { try { staleChips[sc].remove(); } catch (e) { } }
          if (subTipFor && (srr.contains(subTipFor) || !subTipFor.isConnected)) hideSubTip();
        }
      } catch (e) { }
      wantedEl = composer = cardCache = null;
      bar.remove();
      panel.remove();   // v80：面板挂 body，dispose 需单独摘除
      subPanel.remove();
      tip.remove();
      excBubble.remove();
    }
    var api = {
      pid: pid, slot: slot, dispose: dispose,
      ownsComposer: function (el) { return !inactive() && composer === el; },
      attach: function (el, sid) {   // 协调器派发：pane 最靠下的可见输入框 + 其 data-session-id
        if (inactive()) return;
        wantedEl = el;
        pendingSid = sid || "";
        heavy();   // 立即对账（composer 重建/pane 关闭的最快收敛路径）
      },
      render: render,
      applyBarTheme: applyBarTheme,
      syncUpdate: syncUpdate,
      rebuild: function () {
        gear.setAttribute("aria-label", L("打开状态条设置", "Open status bar settings"));
        buildPanel();
        rebuildExcBubble();
        syncPanel();
      },
      getSid: function () { return pickedSid || ""; },
      getQuotaSelection: function () {
        if (inactive()) return null;
        if (quotaSelection) return quotaSelection;
        var sid = instSid || pickedSid || "";
        return sid ? { sid: sid, providerId: effectiveQuotaProvider(), modelId: quotaModel } : null;
      },
      getScope: function () { return inactive() ? null : readPaneScope(wantedEl, pickedSid, pid); },
      gitTouch: function () {
        if (inactive()) return;
        enhanceGitChip();
      },   // v96：主进程推送 git 状态后即时对账（不等 heavy）
      /* v71 确定性历史行数据源：DOM turn id（turnId 或 productTurnId 形态）→ tracker 统计 */
      statsFor: function (tid) {
        var h = bridge.handle;
        if (!h || h.dead || typeof tid !== "string") return null;
        if (!sideHandleValid(h)) { bridgeDetach(h); updateLive(); return null; }
        var s = h.tracker.get(tid);
        if (!s) {
          var key = h.alias[tid];
          if (key && key !== tid) s = h.tracker.get(key);
        }
        return s;
      },
      /* v174：本实例的会话根（detach/dispose 后为 null）——确定性统计行归属判定用 */
      detRoot: function () { return !inactive() && detRootEl && detRootEl.isConnected ? detRootEl : null; },
      /* v174：tid 是否本实例当前活跃轮（productTurnId 或经 alias 映射）——富文本只追活跃轮 */
      isCurrentTurn: function (tid) {
        var h = bridge.handle;
        if (!sideHandleValid(h) || !tid) return false;
        if (tid === bridge.turnId) return true;
        return h.alias[tid] === bridge.turnId;
      },
      /* v86 诊断：桥接绑定状态与当前快照窗口（行数/序号/代际）——重启后历史轮可见性取决于它 */
      bridgeInfo: function () {
        var h = bridge.handle, info = { bound: !!(h && !h.dead), sid: h ? String(h.sid).slice(-8) : "", rebinds: bridge.rebinds || 0 };
        if (!info.bound) return info;
        var snap = null;
        try { var st = h.store.getState(); snap = st && st.snapshot; } catch (e) { info.err = String(e); }
        if (snap) {
          info.win = snap.rows && Array.isArray(snap.rows.window) ? snap.rows.window.length : null;
          info.seq = snap.seq;
          info.epoch = String(snap.logEpoch).slice(0, 12);
          info.heads = 0;
          try { snap.rows.window.forEach(function (r) { if (r && r.kind === "turnHeader") info.heads++; }); } catch (e) { }
        }
        return info;
      },
      rotatorStats: function () { return inactive() ? null : { stats: liveStatsCur, model: quotaModel, provider: quotaProvider, session: lastView && lastView.session }; },
      liveEl: function () { return liveEl; },   // 测试缝：实时段节点引用
      liveIconKind: function () { return liveIconCur; },   // 测试缝：当前 chip 图标（think/bolt/空）
    };
    instances.push(api);
    applyBarTheme();
    refreshWants();
    return api;
  }
})();