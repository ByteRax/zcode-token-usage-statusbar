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
  var MY_GEN = (window.__zusageGen = (window.__zusageGen || 0) + 1);
  function stale() { return disposed || MY_GEN !== window.__zusageGen; }
  if (window.__zusageRateCleanup) window.__zusageRateCleanup();

  /* v291：代际号进 diag——重注入取证不再依赖偶发的计数字段归零（FATAL.gen 严格
   * 递增 = 新代际首帧实证，与 window.__zusageGen 同源；单例守卫下每代恰执行一次） */
  var FATAL = (window.__zusageDiag = { gen: MY_GEN });
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
    document.querySelectorAll(".zusage-root,.zusage-tip-root,.zusage-exc,.zusage-rate-tip,.zusage-quota-tip,.zu-quota,.zu-git,.zu-tsb,.zu-compact-btn,.zu-ac-info,.zu-ac-hint,.zu-compact-dlg,.zu-rot-pk-dlg,.zusage-git-tip,.zusage-panel,.zu-mp-host,.zu-mp-ov,[data-zusage-deterministic],[data-zusage-loading-status],.zu-subrate,.zu-wfrun,.zu-substat,.zu-enhance").forEach(function (el) { el.remove(); });
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
  var LS = { show: "zusage3.show", devKeepTip: "zusage3.devKeepTip", ctxOv: "zusage3.ctxOv", lang: "zusage3.lang", cnNum: "zusage3.cnNum", sec: "zusage3.sec", rstCdh: "zusage3.rstCdh", projPath: "zusage3.projPath", theme: "zusage3.theme", ctxEnh: "zusage3.ctxEnh", cmdkW: "zusage3.cmdkW", updSeen: "zusage3.updSeen", forceKmb: "zusage3.forceKmb", ctxCpt: "zusage3.ctxCpt", cost: "zusage3.cost", barJust: "zusage3.barJust", autoCompact: "zusage3.autoCompact", tipClick: "zusage3.tipClick", quotaRemain: "zusage3.quotaRemain" };
  var state = {
    show: { win: 1, turn: 1, today: 1, sub: 1, tools: 1, git: 1, proj: 1, subRate: 1, wfChip: 1 },   // git：工具行 Git 状态 chip（v96，默认开）；proj：项目累计格（v159，默认开；与 zusage3.projPath 弹窗路径开关无关）；subRate：Agent 行内子代理速率 chip（v178，默认开；只门控行内展示，槽位估算与主 chip 合计不受影响）；wfChip：工作流 run 卡汇总 chip（v332，默认开；specs/workflow-support.md）
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
  function forgetPluginRequest(id) { if (id) delete pluginRequestCallbacks[id]; }
  window.__zusagePluginResult = function (result) {
    if (!result || typeof result.id !== "string") return;
    var done = pluginRequestCallbacks[result.id];
    if (!done) return;
    delete pluginRequestCallbacks[result.id];
    try { done(result); } catch (e) { FATAL.pluginResultErr = "result handler failed"; }
  };
