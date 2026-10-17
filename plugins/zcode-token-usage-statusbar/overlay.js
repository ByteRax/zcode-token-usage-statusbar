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
  /* 多实例（v61.1）：热更新时泵只按 id 清 0 号条，其余实例的 DOM（条/tip/气泡/面板）
   * 在新代码启动时按类名统一自清；旧实例闭包靠 stale() 罢工。
   * 确定性历史行（[data-zusage-deterministic]，挂在消息流 turn 容器末尾）一并自清。
   * v80：面板（.zusage-panel）挂 body 不随条走，清理选择器单列。 */
  try {
    document.querySelectorAll(".zusage-root,.zusage-tip-root,.zusage-exc,.zusage-rate-tip,.zusage-panel,[data-zusage-deterministic],[data-zusage-loading-status]").forEach(function (el) { el.remove(); });
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
  var LS = { show: "zusage3.show", ctxOv: "zusage3.ctxOv", lang: "zusage3.lang", cnNum: "zusage3.cnNum" };
  var state = {
    show: { win: 1, ctx: 1, today: 1, turn: 1, sub: 1, tools: 1 },
    ctxOv: "", data: null,
    lang: "zh", pluginUpdate: window.__zusagePluginState || null,
    /* 万/亿单位开关：缺省开启，仅显式 "0" 关闭；只在中文界面展示并生效（英文始终 K/M/B） */
    cnNum: 1,
    /* 逐问速率行开关：真值在运行时 config.json 的 answer_rate_line（主进程随插件状态推送
       rateLine 字段），渲染端只做展示与请求转发；缺省开启 */
    rateLine: !(window.__zusagePluginState && window.__zusagePluginState.rateLine === false),
  };
  /* ---------- i18n（v57）：L(中文, English) 内联双语文案，语言存 localStorage ---------- */
  function L(zh, en) { return state.lang === "en" ? en : zh; }
  /* 万/亿单位是否生效：状态条 fmt()、占位统计行与 turn-text 请求共用同一判定 */
  function cnUnits() { return state.lang !== "en" && !!state.cnNum; }
  function ls(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  try {
    var s0 = JSON.parse(ls(LS.show, "null"));
    if (s0 && typeof s0 === "object") {
      for (var k0 in state.show) if (k0 in s0) state.show[k0] = s0[k0] ? 1 : 0;
    }
    state.ctxOv = ls(LS.ctxOv, "");
    if (ls(LS.lang, "") === "en") state.lang = "en";
    if (ls(LS.cnNum, "") === "0") state.cnNum = 0;
  } catch (e) { }
  function persist() {
    lsSet(LS.show, JSON.stringify(state.show));
    lsSet(LS.ctxOv, state.ctxOv);
    lsSet(LS.lang, state.lang);
    lsSet(LS.cnNum, state.cnNum ? "1" : "0");
  }

  /* ---------- 多实例注册表（v61.1）：每个分屏 pane 一个条实例 ---------- */
  var instances = [];   // spawnInstance 返回的 api：{pid, attach, render, ...}
  var nextSlot = 0;     // 实例序号；0 号保留兼容 id（#zusage-bar，泵热更新按它清理）
  function renderAll(rebuildPanels) {
    if (rateTipFor) showRateTip(rateTipFor);
    for (var i = 0; i < instances.length; i++) {
      if (rebuildPanels) instances[i].rebuild();   // 语言切换等文案重建（各实例面板独立 DOM）
      if (state.data) instances[i].render(state.data);
    }
  }
  var remoteCache = {};
  var remoteTodayCache = {};
  /* v84（issue #30）：渲染端当下读到的主叶工作台归属（refreshWants 每轮刷新）。泵推送的
   * scope_bindings 取自上一轮收集，主叶身份刚切换/撤销时旧绑定可能随迟到的远端响应到达；
   * sessionFor 以此做守卫，不让旧代际绑定重新点亮远端视图。 */
  var mainScopeNow = { sid: "", identity: "" };
  function sessionFor(d, sid, pid) {
    var binding = d.scope_bindings || {};
    // 空 identity 是显式本地绑定；真实 pane 缺绑定时也不能继承同 sid 的远端。
    var identity = Object.prototype.hasOwnProperty.call(binding, pid) ? binding[pid]
      : (pid === "auto" && Object.prototype.hasOwnProperty.call(binding, sid) ? binding[sid] : "");
    /* v84（issue #30）主叶迟到载荷守卫。typeof 兼容测试夹具按源码片段抽取运行（无模块级声明）：
     * 夹具里 mainScopeNow 由 refreshWants 赋值成为全局；生产环境恒有模块级声明。 */
    if (pid === "workspace-main" && identity &&
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
      if (target) remoteCache[key] = found;
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
    if (d.remote_today) for (var key in d.remote_today) {
      if (d.remote_today[key] && typeof d.remote_today[key] === "object") remoteTodayCache[key] = d.remote_today[key];
    }
    state.data = d;
    for (var i = 0; i < instances.length; i++) {
      try { instances[i].render(d); } catch (e) { FATAL.updateErr = String((e && e.stack) || e); }
    }
  };
  window.__zusagePluginRequests = [];
  function pluginRequest(action, enabled) {
    window.__zusagePluginRequests.push({ action: action, enabled: enabled });
  }
  window.__zusagePluginUpdate = function (s) {
    if (stale() || JSON.stringify(state.pluginUpdate) === JSON.stringify(s)) return;
    window.__zusagePluginState = state.pluginUpdate = s;
    if (s && typeof s.rateLine === "boolean") state.rateLine = s.rateLine;
    scanRateLines();
    instances.forEach(function (inst) { inst.syncUpdate(); });
  };
  /* v12 多服务器路由：sid → workspaceIdentity（remote:ssh:host:port:user:path，重连换代不变）。
   * 来源1 客户端 pane 布局树（本窗口各 pane 的 sessionId + workspaceScope，最新鲜）；
   * 来源2 zcode-v4-last-session:v1:<workspaceKey> 前缀键（跨窗口历史，仅补缺）。
   * 泵将候选与本窗可信 workspace/task IPC 做交集；歧义不猜，JSON 请求携带 identity。 */
  function collectSidWs() {
    var map = {};
    function add(sid, identity) {
      if (!sid || !identity || String(identity).indexOf("remote:ssh:") !== 0) return;
      if (!map[sid]) map[sid] = [];
      if (map[sid].indexOf(String(identity)) < 0) map[sid].push(String(identity));
    }
    try {
      var tree = JSON.parse(localStorage.getItem("zcode-v4-pane-layout:v2") || "null");
      var panes = tree && tree.panes;
      if (panes) for (var pid in panes) {
        var pn = panes[pid] || {}, sc = pn.workspaceScope || {};
        var idt = sc.workspaceIdentity, sid2 = pn.sessionId;
        add(sid2, idt);
      }
    } catch (e) { }
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (typeof k !== "string" || k.indexOf("zcode-v4-last-session:v1:") !== 0) continue;
        var wk = k.slice("zcode-v4-last-session:v1:".length);
        if (wk.indexOf("remote:") !== 0) continue;
        var v = localStorage.getItem(k), sid3 = v;
        if (v && v.charAt(0) === '"') { try { sid3 = JSON.parse(v); } catch (e2) { } }
        else if (v && v.charAt(0) === "{") {
          try { sid3 = JSON.parse(v).sessionId; } catch (e3) { }
        }
        if (sid3 && typeof sid3 === "string") add(sid3, wk);
      }
    } catch (e4) { }
    return map;
  }
  /* v84（issue #30）主叶工作区身份：宿主把每个工作台分组（主标签页）的当前主绑定持久化在
   * zcode-v4-session-workbench-groups:v1（groups[].primaryBinding = {workspaceScope, sessionId}，
   * 切换会话即改写、关闭分组即删除，宿主每次变更同步写回 localStorage）。当前主叶 sid 恰好
   * 只被一个分组绑为主会话且该 scope 是 remote:ssh: 时，即主标签页归属的直接证据；出现任何
   * 第二个不同 scope（含本地主叶分组——多窗口共享同一 localStorage，同 sid 碰撞无法区分窗口）
   * 都返回 ""，泵维持仅本地查询。泵侧仍按同窗口可信 workspace IPC 与 tasks 一致性复核。 */
  function mainWorkbenchScope(sid) {
    if (!sid) return "";
    try {
      var data = JSON.parse(ls("zcode-v4-session-workbench-groups:v1", "null"));
      var groups = data && data.groups;
      if (!groups || typeof groups !== "object") return "";
      var found = "", seen = {};
      for (var gid in groups) {
        var pb = groups[gid] && groups[gid].primaryBinding;
        if (!pb || pb.sessionId !== sid) continue;
        var scope = pb.workspaceScope, key = "";
        if (scope && typeof scope === "object") key = String(scope.workspaceIdentity || scope.workspacePath || "");
        else if (typeof scope === "string") key = scope;
        key = key.trim();
        if (!key || seen[key]) continue;
        seen[key] = 1;
        if (found) return "";   // ≥2 个不同 scope：歧义不猜
        found = key;
      }
      return found.indexOf("remote:ssh:") === 0 ? found : "";
    } catch (e) { return ""; }
  }
  function refreshWants() {
    /* 各 pane 会话 id 汇总给泵：__zusageWantSids（新泵按数组强制纳入快照），
     * __zusageWantSid 保底兼容旧泵单值通路（取 0 号实例的会话）；
     * __zusageSidWs 供多服务器路由（v12，旧泵忽略）。 */
    try {
      var arr = [];
      for (var i = 0; i < instances.length; i++) {
        var s1 = instances[i].getSid();
        if (s1 && arr.indexOf(s1) < 0) arr.push(s1);
      }
      window.__zusageWantSids = arr;
      if (arr.length) window.__zusageWantSid = arr[0];
      window.__zusageSidWs = collectSidWs();
      var panes = {};
      try {
        var layout = JSON.parse(ls("zcode-v4-pane-layout:v2", "null"));
        for (var n = 0; n < instances.length; n++) {
          var inst = instances[n], binding = layout && layout.panes && layout.panes[inst.pid];
          if (binding && binding.sessionId === inst.getSid() && binding.workspaceScope) {
            var layoutIdentity = binding.workspaceScope.workspaceIdentity || "";
            panes[inst.pid] = { sid: inst.getSid(), identity: layoutIdentity };
            if (inst.pid === "workspace-main") mainScopeNow = { sid: inst.getSid(), identity: layoutIdentity };
          } else if (inst.pid === "workspace-main" && inst.getSid()) {
            /* 宿主主叶不进入持久化 panes；上报当前 DOM 会话 + 工作台分组的唯一远端主绑定
             * （issue #30）。缺可靠证据或归属歧义时仍只报 {sid}，泵维持仅本地查询。 */
            var mainWs = mainWorkbenchScope(inst.getSid());
            panes[inst.pid] = mainWs ? { sid: inst.getSid(), identity: mainWs } : { sid: inst.getSid() };
            mainScopeNow = { sid: inst.getSid(), identity: mainWs || "" };
          } else if (inst.pid === "workspace-main") {
            mainScopeNow = { sid: "", identity: "" };
          }
        }
      } catch (e2) { }
      window.__zusagePaneScopes = panes;
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
      row(L("生成", "Gen"), L("各段生成窗口合计：含思考（含 Claude 这类不单独上报思考的模型）用 completed_at − started_at，否则用 completed_at − first_token_at；不含段间工具等待", "sum of segment generation windows: with thinking (including models such as Claude that don't report it separately) use completed_at − started_at, otherwise completed_at − first_token_at; tool waits between segments excluded")) +
      row(L("段 / 峰", "Seg/Peak"), L("段＝模型请求次数；峰＝最快一段的速率", "segments = model requests; peak = fastest segment")) +
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
    window.removeEventListener("scroll", hideRateTip, true);
    rateBindings.forEach(unbindRateLine);
    rateBindings = [];
    noticeNodes.forEach(clearNotice);
    noticeNodes = [];
    noticeStyle.remove();
    hideRateTip();
    rateTip.remove();
    if (window.__zusageRateCleanup === cleanupRateTip) delete window.__zusageRateCleanup;
  }
  window.addEventListener("scroll", hideRateTip, true);   // 捕获：任意容器滚动即收
  var rateScanTimer = setInterval(scanRateLines, 2000);
  window.__zusageRateCleanup = cleanupRateTip;
  scanRateLines();

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
  function zuTryBindStore(sid) {
    var api = zuBridgeApi();
    if (!api || !sid) return null;
    var diag = null;
    try { diag = api.diag(); } catch (e) { return null; }
    var sessions = (diag && diag.sessions) || [];
    var topic = "conversation/" + sid;
    for (var i = 0; i < sessions.length; i++) {
      var entry = sessions[i];
      if (!entry || entry.topic !== topic) continue;
      var key = String(entry.key || ""), sp = key.indexOf(" ");
      if (sp < 0) continue;
      var remote = key.slice(0, sp), workspace = key.slice(sp + 1);
      if (!remote || !workspace.trim()) continue;
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
    var text = TURN_STATS.format(stats, cnUnits());
    return text.indexOf("token/s") >= 0 ? text.replace("token/s", "token/s(本轮)") : text + "(本轮)";
  }
  function zuUnavailableText() {
    return "⚡ " + L("本轮统计不可用", "turn stats unavailable") + "(本轮)";
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
  /* 返回 null = 调用方应把这当成"没有可展示的桥接视图"处理（回退 DB/不渲染），
   * 而不是当成"确定性地算出了没有速度"。 */
  function zuBarSpeedView(stats, charsPerToken) {
    if (!stats.complete) {
      // 工具执行期间优先显示与消息流同款的状态词（正在读取/正在编辑…+已耗时），
      // 让悬浮条与 toolCall 行状态对应；没有工具在跑才退回字符估算/存活心跳。
      if (stats.runningTool) {
        var verb = zuToolVerb(stats.runningTool.name);
        var st = stats.runningTool.startedAt;
        if (typeof st === "number" && st > 0 && Date.now() >= st)
          verb += " · " + ((Date.now() - st) / 1000).toFixed(1) + "s";
        return { cls: "dim", text: verb, phase: "tool" };
      }
      // 无工具且无可测字符流（首段未流出/字符停滞>2s，多数模型思考期对桥不可见，
      // 看到的就是时间在走）：按用户语义定为"思考中"——动效脑图标 + 思考中…Xs。
      // 秒数是本轮存活时长（首观测起算），不是精确思考时长。
      if (stats.characterRate == null)
        return { cls: "dim", text: L("思考中…", "thinking…") + (stats.observedMs / 1000).toFixed(1) + "s",
                 phase: "thinking" };
      var est = stats.characterRate / (charsPerToken || DEFAULT_CHARS_PER_TOKEN);
      return { cls: "dim", text: est.toFixed(1) + L(" t/s", " t/s"),
               /* phase 兜底 thinking：新轮刚开始（最后活动行还是 userInput）时
                * stats.phase 为 null，不兜底会让图标在这一瞬回闪电再切回脑（闪烁）。 */
               phase: stats.phase || "thinking" };
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
    var cls = stats.tokenRate >= 70 ? "ok" : stats.tokenRate >= 40 ? "warm" : "hot";
    return { cls: cls, text: stats.tokenRate.toFixed(1) + L(" t/s", " t/s"), phase: null };
  }
  /* 思考态动效图标（用户提供的设计稿）：呼吸脑轮廓 + 流动信号 + 脉冲节点，纯 CSS
   * 动画内嵌在 SVG 里（样式随节点走，不依赖外部样式表，宿主清 head 也不受影响）。
   * 类名一律 zu-tk-* 前缀，防与宿主/插件其它样式互相污染；prefers-reduced-motion
   * 时停播（动画 none，信号线半透明保持可读）。 */
  function zuIcoThinking() {
    return '<svg class="ico zu-think" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
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
      '<g class="zu-tk-brain" stroke="#7e8899" stroke-width="1.5">' +
      '<path d="M12 5.3C12 2.2 7.5 2 6.8 5.2C4.2 4.8 2.7 7.3 3.6 9.5C1.5 11 1.6 14.1 3.8 15.4C3.1 18 5 20 7.2 19.5C8.2 22 12 21.2 12 18.5V5.3Z"/>' +
      '<path d="M12 5.3C12 2.2 16.5 2 17.2 5.2C19.8 4.8 21.3 7.3 20.4 9.5C22.5 11 22.4 14.1 20.2 15.4C20.9 18 19 20 16.8 19.5C15.8 22 12 21.2 12 18.5"/>' +
      '</g>' +
      '<g stroke="#8171E8" stroke-width="1.2" opacity=".45">' +
      '<path d="M7 7.5V10L9 12V16.5M17 7.5V10L15 12V16.5M5.5 14H7L9 16.5M18.5 14H17L15 16.5"/>' +
      '</g>' +
      '<g stroke="#A385E6" stroke-width="1.4">' +
      '<path class="zu-tk-signal" d="M7 7.5V10L9 12V16.5"/>' +
      '<path class="zu-tk-signal" style="animation-delay:-1.2s" d="M15 16.5V12L17 10V7.5"/>' +
      '</g>' +
      '</g>' +
      '<g fill="#A385E6">' +
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
   * 的同一条查询。key 用扫描循环里的 DOM tid（statsFor(tid) 的入参，虚拟列表重挂后
   * 还能对应回同一个容器）；请求/交付按 sid 关联（richTextRequestTids 是 sid→tid 的
   * 反向映射，同一 session 同一时刻只认最新发起的那个 tid——如果请求在途时又有新的
   * 一轮在同一 session 完成，交付结果可能被关联到新 tid 上而非发起时的旧 tid，这是
   * 一个已知的、极窄时间窗口内的小概率错位，权衡实现复杂度后不做进一步纠偏）。 */
  var richTextCache = {}, richTextAttempts = {}, richTextRequestTids = {};
  var RICH_TEXT_MAX_ATTEMPTS = 6;   // 2s 一 tick × 6 ≈ 12s 窗口等数据库追上，之后永久用简化文案兜底
  function zuResetRichText() {
    richTextCache = {};
    richTextAttempts = {};
    richTextRequestTids = {};
  }
  /* 每个 scan tick 对「已完成 + 有输出 + 尚无富文本 + 未超重试上限」的 turn 补发一次请求：
   * 只靠首次完成时那一次会漏（主进程没收到/当时无窗口/查询失败），逐 tick 补发才能自愈。 */
  function zuRequestTurnText(tid, stats) {
    if (!tid || richTextCache[tid] || (richTextAttempts[tid] || 0) >= RICH_TEXT_MAX_ATTEMPTS) return;
    var sid = stats && typeof stats.sessionId === "string" ? stats.sessionId : "";
    if (!sid) return;
    richTextRequestTids[sid] = tid;
    /* cn：万/亿开关当前值；为 0 时主进程给 token_rate.py 加 --no-cn-units（Python 读不到渲染端 localStorage，缺省万/亿） */
    var req = { action: "turn-text", sid: sid, cn: cnUnits() ? 1 : 0 };
    if (window.__zusagePluginRequests) window.__zusagePluginRequests.push(req);
    else window.__zusagePluginRequests = [req];
    richTextAttempts[tid] = (richTextAttempts[tid] || 0) + 1;
  }
  /* 主进程回推：非空 = 富文本到位，写缓存并立即重扫（不等下一个 2s tick）；空 = 库里还没
   * 追到这一轮（或没有有效的提问时刻可推断），什么都不做——重试由 scanDeterministicLines
   * 的定时扫描自然驱动，这里绝不自建重试队列（否则两个驱动源叠加会绕开 attempts 上限）。 */
  window.__zusageDeliverTurnText = function (sid, text) {
    if (stale() || typeof sid !== "string") return;
    var tid = richTextRequestTids[sid];
    if (!tid || typeof text !== "string" || !text) return;
    richTextCache[tid] = text;
    delete richTextAttempts[tid];
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
  function scanDeterministicLines() {
    if (stale()) return;
    try {
      if (!state.rateLine || !TURN_STATS) {   // 开关关闭：撤下自己插的行（模型历史行不动）
        document.querySelectorAll("[data-zusage-deterministic]").forEach(function (el) { el.remove(); });
        return;
      }
      /* 两种选择器可能同时命中同一个 turn（外层 [data-v4-turn-unit] 包着内层
       * section，二者带同一个 data-turn-id）：按 tid 去重，section 更具体，优先用它
       * 当容器，避免同一轮被当成两个独立容器各插一条，出现重复行（真机实测过）。 */
      var boxes = [], seen = {};
      document.querySelectorAll("section[data-turn-id]").forEach(function (el) {
        var t = el.getAttribute("data-turn-id");
        if (t && !seen[t]) { seen[t] = 1; boxes.push(el); }
      });
      document.querySelectorAll("[data-v4-turn-unit][data-turn-id]").forEach(function (el) {
        var t = el.getAttribute("data-turn-id");
        if (t && !seen[t]) { seen[t] = 1; boxes.push(el); }
      });
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        var tid = box.getAttribute && box.getAttribute("data-turn-id");
        if (!tid) continue;
        var mine = null;
        try { mine = box.querySelector("[data-zusage-deterministic]"); } catch (e) { }
        if (mine) {
          /* 已插过：重挂/数据演进后从 tracker 重建文本；观测过但记录已清（换代）、
           * 或完成但确实零输出（无意义数字，如"耗时 939.0s"配"输出 0 tok"）则明示不可用 */
          var again = null;
          for (var n = 0; n < instances.length; n++) { again = instances[n].statsFor(tid); if (again) break; }
          var againOk = !!again && again.complete && zuHasMeaningfulOutput(again);
          var againText = againOk ? zuFinalText(again) : zuUnavailableText();
          if (againOk) zuRequestTurnText(tid, again);   // 仍缺富文本就补发（限流见函数内）
          var text = richTextCache[tid] || againText;
          var line = mine.querySelector("p") || mine;
          if ((line.textContent || "") !== text) line.textContent = text;
          if (!line.style.fontSize) line.style.fontSize = ZU_DET_FONT_SIZE;   // 旧代节点补样式（热更间隙）
          zuDetPlace(box, mine);   // React 重排后兜住用户指定位置（工具条之前）
          continue;
        }
        var hasModel = false;
        try {
          box.querySelectorAll("blockquote p, blockquote, p").forEach(function (el) {
            if (!hasModel && isRateLine(el)) hasModel = true;
          });
        } catch (e) { }
        if (hasModel) continue;   // 模型历史统计行在位：不叠双行
        var stats = null;
        for (var k = 0; k < instances.length; k++) { stats = instances[k].statsFor(tid); if (stats) break; }
        if (!stats || !stats.complete) continue;   // 未完成 / 旧消息（tracker 无记录）不插
        var quote = document.createElement("blockquote");
        quote.dataset.zusageDeterministic = "1";
        var p = document.createElement("p");
        p.dataset.zusageDeterministic = "1";
        /* 样式基本交还宿主默认（模型时代贴的 Markdown 引用块就是这套渲染：彩色 ⚡、
         * 正文亮度、引用线）；唯一例外字号（v78）：用户反馈宿主正文号太大，内联缩到
         * 0.8125rem（13px）。必须内联——本节点长在宿主消息流 prose 容器内，bar 内部
         * 样式表够不着，挂 head 的外来样式又会被 React 清掉（历史根因）。 */
        p.style.fontSize = ZU_DET_FONT_SIZE;
        var statsOk = zuHasMeaningfulOutput(stats);
        if (statsOk) zuRequestTurnText(tid, stats);   // 先占位，向主进程要这轮的数据库富文本
        p.textContent = richTextCache[tid] || (statsOk ? zuFinalText(stats) : zuUnavailableText());
        quote.appendChild(p);
        zuDetPlace(box, quote);
      }
    } catch (e) { FATAL.detErr = String((e && e.stack) || e); }
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
    Read: ["正在读取", "Reading"],
    Write: ["正在写入", "Writing"], Edit: ["正在编辑", "Editing"], ApplyPatch: ["正在编辑", "Editing"],
    Bash: ["正在执行", "Running command"],
    Grep: ["正在搜索", "Searching"], Glob: ["正在搜索", "Searching"],
    WebSearch: ["正在搜索", "Searching"], web_search: ["正在搜索", "Searching"],
    WebFetch: ["正在获取网页", "Fetching page"],
    TodoWrite: ["正在更新待办", "Updating todos"], TodoRead: ["正在读取待办", "Reading todos"],
    Skill: ["正在运行技能", "Running skill"],
    ReadSessionContext: ["正在读取上下文", "Reading context"],
    Agent: ["正在运行子智能体", "Running agent"], Task: ["正在运行子智能体", "Running agent"],
    SendMessage: ["正在发送消息", "Sending message"],
    TaskOutput: ["正在获取任务输出", "Fetching task output"],
    TaskStop: ["正在停止任务", "Stopping task"],
    CreateWorkflow: ["正在编写工作流", "Writing workflow"],
  };
  function zuToolVerb(name) {
    if (name && ZU_TOOL_VERBS[name]) { var pair = ZU_TOOL_VERBS[name]; return L(pair[0], pair[1]); }
    if (name && name.indexOf("mcp__computer-use__") === 0) return L("正在操作电脑", "Operating computer");
    if (name && name.indexOf("mcp__") === 0)
      return L("正在调用 " + name.slice(5).replace(/__/g, " · "), "Calling " + name.slice(5).replace(/__/g, " · "));
    if (name && name.indexOf("js") === 0) return L("正在执行代码", "Executing code");
    return name ? L("正在执行 " + name, "Running " + name) : L("执行中", "Working");
  }
  /* v78：消息流 loading 状态词（v76 的 [data-zusage-loading-status] 插槽插入）已删——
   * 悬浮条合并 chip 在工具执行期仍显示同款动词+耗时（zuBarSpeedView），消息流内不再插节点。
   * 清理选择器保留（根清理 + dispose）：热更/重载后把旧版本可能残留的 span 清干净。 */
  function sharedTick() {
    if (stale()) return;
    scanDeterministicLines();
  }
  detTimer = setInterval(sharedTick, 2000);
  sharedTick();

  function disposeOverlay() {
    if (disposed) return;
    disposed = true;
    clearTimeout(bootTimer);
    clearInterval(coordinatorTimer);
    instances.forEach(function (inst) { inst.dispose(); });
    instances = [];
    cleanupRateTip();
    cleanupDeterministic();
    window.__zusageWantSids = [];
    window.__zusageWantSid = "";
    if (window.__zusageDispose === disposeOverlay) {
      delete window.__zusageDispose;
      delete window.__zusageUpdate;
      delete window.__zusagePluginUpdate;
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
    var SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
    function tick() {
      if (stale()) return;
      try {
        var best = {};
        document.querySelectorAll(SEL).forEach(function (el) {
          if (el.closest && el.closest('[role="dialog"]')) return;   // v62：弹窗内的编辑框不是聊天输入框，不派实例（issue #9）
          var r = el.getBoundingClientRect();
          if (!(r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < innerHeight)) return;
          if (r.top < innerHeight * 0.45) return;   // 聊天输入框特征：视口下半部（排除设置页等处元素）
          var k = paneKeyOf(el);
          if (!best[k] || r.top > best[k].top) best[k] = { el: el, top: r.top };
        });
        var keys = Object.keys(best);
        if (!keys.length) { best["auto"] = { el: null, top: 0 }; keys = ["auto"]; }   // shadow/iframe 兜底
        instances = instances.filter(function (inst) {
          if (keys.indexOf(inst.pid) >= 0) return true;
          inst.dispose();
          return false;
        });
        keys.forEach(function (k) {
          var inst = null;
          for (var i = 0; i < instances.length; i++) if (instances[i].pid === k) { inst = instances[i]; break; }
          if (!inst && instances.length < 4) inst = spawnInstance(k, nextSlot++);
          if (inst) inst.attach(best[k].el, sessIdOf(best[k].el));
        });
        refreshWants();
        FATAL.insts = instances.map(function (a) { return a.pid + "=" + (a.getSid() ? a.getSid().slice(-8) : "-"); }).join(" | ");
      } catch (e) { FATAL.coordErr = String((e && e.stack) || e); }
    }
    tick();
    coordinatorTimer = setInterval(tick, 600);
  }

  /* ---------- 实例工厂（v61.1）：一个 pane 一套 条/面板/气泡/tooltip/定位循环。
   * slot 0 保留 #zusage-bar/#zusage-tip 兼容 id（泵热更新按它清理），其余实例仅类名。 */
  function spawnInstance(pid, slot) {
    var VERSION = "v85";   // v81 tooltip 宿主同款 → v82 统计行锚点深度查找（新会话结构嵌套在 group/assistant-turn 内容列内）→ v83 万/亿单位开关（默认开、仅中文）+ K/M/B 的 B 档 → v84 主标签页远端路由（工作台分组唯一主绑定上报 + 迟到载荷守卫，issue #30）→ v85 回答末尾统计行跟随万/亿开关 + tok→token   // 悬停 ⚙ 面板可见；本会话热修部署未走提交，版本号随部署代际递增
    var instanceDisposed = false, heavyTimer = 0, frame = 0, themeObserver = null;
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
      pendingSid = "", wantedEl = null,   // 协调器派发的最新 composer/会话
      shrink = 0,         // 分级收缩（v66）：1 = 内容超卡片宽，「本轮/会话累计」缓存命中率已让位
      fadeOn = false,     // 收缩后仍超宽：右缘渐隐（.zu-clip）
      bridge = { handle: null, turnId: "", timer: 0 },   // v71 本 pane 的 renderer store 订阅
      liveTextCur = "", liveStatsCur = null, liveKindCur = "fallback", liveEl = null,   // v72：合并「生成速度」用
      livePhaseCur = "", liveIconCur = "bolt";   // v77：当前 chip 阶段与图标（think=思考动效/bolt=闪电）——相位切换需整条重渲染

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
      ".zu-main{overflow:hidden;min-width:0;flex:1 1 auto;display:flex;align-items:center;gap:1px;justify-content:space-between}" +
      /* 收缩兜底（v66）：分级收缩后仍装不下时右缘 26px 渐隐，替代生硬的截断 */
      ".zu-main.zu-clip{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent);" +
      "mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent)}" +
      /* zu-main 不得带 .it class：querySelectorAll('.it') 收集 tooltip 时会把它算进第 0 位，
       * tips 全部错位一位且末项为 null —— v31"悬停只有空胶囊/内容错位"的根因 */
      ".it{display:flex;align-items:center;gap:4px;padding:2px 6px;border-radius:6px;" +
      "transition:background-color .12s ease-out}" +
      ".it:hover{background:var(--color-hover,rgba(255,255,255,.06))}" +
      ".sep{width:1px;height:15px;background:var(--color-border,rgba(255,255,255,.09));flex:0 0 auto;margin:0 1px}" +
      ".k{color:#7e8899}.v{color:var(--color-foreground,#e9edf4);font-weight:600}" +
      ".zu-live{color:var(--color-foreground,#e9edf4);font-weight:600}" +
      ".pct{font-weight:700}.dim{color:var(--color-foreground-subtle,#667082)}" +
      /* 三档状态色刻意不走客户端变量（v58.1）：terminal-bright-* 是语法高亮色板，
       * 绿档在条面小字号/细进度条上发白（用户实测）；改用高对比自调档，
       * 浅色加深版在 .zu-light 组。 */
      ".ok{color:#3ecf8e}.warm{color:#f5b944}.hot{color:#ff6b57}" +
      /* 超限=亮红呼吸闪烁（v38 定性"亮红闪烁优先于一切档位"，v54 落成动画） */
      "@keyframes zuexc{0%,100%{opacity:1}50%{opacity:.4}}" +
      ".exc{color:var(--color-destructive,#ff2d55);text-shadow:0 0 8px rgba(255,45,85,.5);animation:zuexc 1.1s ease-in-out infinite}" +
      ".btn{cursor:pointer;padding:2px 6px;border-radius:6px;color:var(--color-foreground-subtle,#7e8899);" +
      "transition:background-color .12s ease-out,color .12s ease-out}" +
      ".btn:hover{color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".btn:active{transform:scale(.96)}" +
      /* v81：⚙ 原为 +3px（17px），比宿主 group/toolbar 行的任何文字（统一
       * text-ui-base = var(--ui-font-size)）都大一号，改为同基准以对齐工具行观感 */
      ".zu-gear{flex:0 0 auto;font-size:var(--ui-font-size,14px);border-radius:6px}" +
      /* 行内 SVG 线性图标（v54）：currentColor 跟随文字色，一处定义全局换色 */
      ".ico{width:12px;height:12px;flex:0 0 auto;color:var(--color-foreground-subtle,#7e8899);opacity:.85}" +
      /* 思考态动效图标（v77）：自带配色（脑灰+紫信号），略大于常规线性图标——
       * 12px 下 4 个脉冲节点会缩没；不撑高条面（行高由文字主导）。 */
      ".zu-think{width:14px;height:14px;opacity:1}" +
      /* 工具错误数徽标 */
      ".eb{background:rgba(255,107,87,.14);background:color-mix(in srgb,var(--color-destructive,#ff6b57) 14%,transparent);" +
      "color:var(--color-destructive,#ff8a73);border-radius:999px;padding:0 6px;line-height:16px;font-weight:600;display:inline-flex;align-items:center;gap:2px}" +
      ".eb .ico{color:inherit}" +
      ".cbar{display:block;width:calc(var(--ui-font-size,14px) + 2px);height:calc(var(--ui-font-size,14px) + 2px);flex:0 0 auto;fill:none;stroke-width:3}" +
      ".cbar-track{stroke:var(--color-hover,rgba(255,255,255,.1))}" +
      ".cbar-value{stroke:currentColor}" +
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
      ".panel::-webkit-scrollbar{width:8px}" +
      ".panel::-webkit-scrollbar-thumb{background:var(--color-border,rgba(255,255,255,.14));border-radius:999px}" +
      ".panel label{display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:5px 8px;margin:0 -8px;" +
      "border-radius:8px;transition:background-color .12s ease-out}" +
      ".panel input[type=text]{width:110px;background:var(--color-input,rgba(0,0,0,.3));border:1px solid var(--color-border,rgba(255,255,255,.14));" +
      "color:var(--color-foreground,#e9edf4);border-radius:6px;padding:2px 7px;font:inherit;outline:none}" +
      ".panel input[type=text]:focus{border-color:var(--color-brand,#57c7ff);box-shadow:0 0 0 2px rgba(87,199,255,.15)}" +
      ".panel .hr{border-top:1px solid var(--color-border,rgba(255,255,255,.08));margin:5px 0}" +
      ".panel .cap{color:var(--color-foreground-subtlest,#6b7484);margin:4px 0 2px;font-size:calc(var(--ui-font-size,14px) - 2px);letter-spacing:.08em}" +
      ".panel .phead{font-weight:700;color:var(--color-foreground,#eef2f8);font-size:calc(var(--ui-font-size,14px) + 2px);margin-bottom:5px;display:flex;align-items:center;gap:8px}" +
      ".panel .pver{color:var(--color-brand,#57c7ff);font-weight:400;font-size:calc(var(--ui-font-size,14px) - 2px);background:rgba(87,199,255,.12);background:color-mix(in srgb,var(--color-brand,#57c7ff) 12%,transparent);border-radius:999px;padding:1px 8px}" +
      ".panel label em{font-style:normal;color:var(--color-foreground-subtle,#6f7989);display:block}" +
      ".panel input[type=checkbox]{accent-color:var(--color-brand,#57c7ff);margin-top:3px}" +
      ".panel .pnote{line-height:1.6;color:var(--color-foreground-subtle,#6f7989);margin-top:3px}" +
      ".panel .zu-update-actions{display:flex;gap:8px;margin:5px 0}" +
      ".panel .zu-update-actions button{font:inherit;color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 10px;cursor:pointer}" +
      ".panel .zu-update-actions button:disabled{opacity:.5;cursor:default}" +
      ".panel .zu-update-status{overflow-wrap:anywhere;white-space:pre-line}" +
      ".panel.zu-settings{box-sizing:border-box;min-width:0;max-width:none;" +
      "max-height:min(72vh,var(--zu-settings-height,72vh));padding:0;gap:0;overflow:hidden;line-height:1.5}" +
      ".zu-settings .zu-settings-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;" +
      "padding:14px 16px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-settings .phead{margin:0;font-size:var(--ui-font-size,14px);font-weight:600}" +
      ".zu-settings .zu-settings-close{background:none;border:0;font:inherit;color:var(--color-foreground-subtle,#8791a3);" +
      "padding:2px 6px;border-radius:6px;cursor:pointer}" +
      ".zu-settings .zu-settings-close:hover{background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".zu-settings .zu-settings-body{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;" +
      "padding:12px 12px 16px;scrollbar-width:thin;scrollbar-color:var(--color-foreground-subtlest,#6b7484) transparent}" +
      ".zu-settings-body::-webkit-scrollbar{width:8px}" +
      ".zu-settings-body::-webkit-scrollbar-thumb{background:var(--color-foreground-subtlest,#6b7484);border:2px solid var(--color-card,#13161e);border-radius:999px}" +
      ".zu-settings.zu-settings-more .zu-settings-body{mask-image:linear-gradient(#000 calc(100% - 16px),transparent)}" +
      ".zu-settings .cap{margin:0 4px 7px;letter-spacing:0;color:var(--color-foreground-subtle,#8791a3);font-weight:600;" +
      "font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-settings .zu-settings-section+.zu-settings-section{margin-top:16px}" +
      ".zu-settings .zu-settings-card{border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:9px;" +
      "background:var(--color-hover,rgba(255,255,255,.03));overflow:hidden}" +
      ".zu-settings label{align-items:center;gap:12px;margin:0;padding:9px 11px;border-radius:0}" +
      ".zu-settings .zu-settings-card>label+label{border-top:1px solid var(--color-border,rgba(255,255,255,.09))}" +
      ".zu-settings label>span{flex:1;min-width:0;font-weight:500}" +
      ".zu-settings label em{font-weight:400;margin-top:2px;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.5}" +
      ".zu-settings input[type=checkbox]{appearance:none;-webkit-appearance:none;order:2;position:relative;flex:0 0 28px;" +
      "width:28px;height:16px;margin:0;border:1px solid var(--color-border,rgba(255,255,255,.18));border-radius:999px;" +
      "background:var(--color-input,rgba(255,255,255,.12));cursor:pointer}" +
      ".zu-settings input[type=checkbox]::before{content:'';position:absolute;left:2px;top:2px;width:10px;height:10px;" +
      "border-radius:50%;background:var(--color-foreground-subtle,#8791a3)}" +
      ".zu-settings input[type=checkbox]:checked{background:var(--color-brand,#57c7ff);border-color:var(--color-brand,#57c7ff)}" +
      ".zu-settings input[type=checkbox]:checked::before{left:14px;background:var(--color-background,#13161e)}" +
      ".zu-settings input:focus-visible,.zu-settings button:focus-visible{outline:2px solid var(--color-brand,#57c7ff);outline-offset:2px}" +
      ".zu-settings input:disabled{opacity:.4;cursor:default}" +
      ".zu-settings .zu-ctxov{order:2;box-sizing:border-box;width:120px;min-width:0;padding:5px 7px}" +
      ".zu-settings .zu-settings-langs{display:flex;gap:8px;padding:9px 11px}" +
      ".zu-settings .zu-settings-langs label{flex:1;padding:5px 8px;border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px}" +
      ".zu-settings input[type=radio]{accent-color:var(--color-brand,#57c7ff);margin:0}" +
      ".zu-settings .zu-settings-detail{padding:0 11px 10px}" +
      ".zu-settings .zu-settings-detail .pnote{font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      ".zu-settings .zu-settings-foot{flex:0 0 auto;display:flex;align-items:center;gap:10px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));padding:9px 12px}" +
      ".zu-settings .zu-settings-scroll{display:block;flex:1;min-width:0;width:auto;border:0;background:none;font:inherit;" +
      "font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-brand,#57c7ff);padding:2px;cursor:pointer}" +
      ".zu-settings .zu-settings-scroll:disabled{color:var(--color-foreground-subtle,#8791a3);cursor:default}" +
      /* 反馈按钮（v70）：常驻底栏右缘，点击经 window.open 交由系统默认浏览器打开 issues */
      ".zu-settings .zu-settings-feedback{flex:0 0 auto;font:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);" +
      "color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));" +
      "border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;padding:3px 10px;cursor:pointer}" +
      /* 子代理明细面板（v49）：点击条目弹出的固定面板（与设置面板同机制，互斥打开）；
       * 面板不随鼠标消失，绕开悬停+tab 的全部几何问题。 */
      ".zu-sub{cursor:pointer}" +
      ".zu-sub:hover .v{color:var(--color-foreground,#fff)}" +
      ".panel.subp{width:420px;max-width:60vw;gap:8px}" +
      ".subrow{padding:8px 10px;background:var(--color-surface,rgba(255,255,255,.03));border:1px solid var(--color-border,rgba(255,255,255,.06));border-radius:8px}" +
      ".subname{font-weight:600;color:var(--color-foreground,#e9edf4);font-size:var(--ui-font-size,14px);overflow-wrap:anywhere}" +
      ".substat{color:var(--color-foreground-subtle,#8791a3);margin-top:2px}" +
      ".sublive{color:#3ecf8e;font-size:calc(var(--ui-font-size,14px) - 2px);font-weight:400;background:rgba(62,207,142,.12);border-radius:999px;padding:0 7px;margin-left:7px}" +
      /* 自绘 tooltip（v31）：向上弹出（原生 title 方向不可控且会被窗口下缘遮挡），
       * 支持多 tab；white-space:pre-line 保留数据里的 \n 换行。
       * v32：fixed 挂 body —— 原 absolute 挂 bar，被页面消息流的层叠上下文盖住
       * （diag 实证 disp=block 但不可见），挂 body 用视口坐标独立定位。
       * v81：底色/边框/文字改宿主 Radix Tooltip 同款（bg-tooltip + border-border +
       * text-tooltip-foreground，反色底：暗色主题白底黑字、浅色主题黑底白字），
       * 内部次级文字用宿主 tooltip-tag 系变量；毛玻璃在实色底下无意义，删。 */
      ".tip{position:fixed;background:var(--color-tooltip,#171717);" +
      "border:1px solid var(--color-border,transparent);border-radius:10px;padding:8px 12px;" +
      "font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);" +
      "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.6;color:var(--color-tooltip-foreground,#fafafa);" +
      "box-shadow:0 10px 28px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3);" +
      "white-space:pre-line;z-index:2147483646;max-width:560px;display:none;scrollbar-width:thin}" +
      /* 结构化 tooltip 行排版（v67.1，与统计行悬停解释同款；仅状态条 .tip 作用域）
       * v81：前景色系改 tooltip 语境（反色底上 --color-foreground 会与底同色不可读） */
      ".tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 6px}" +
      ".tip .rt-row{display:flex;gap:10px;margin:3px 0}" +
      ".tip .rt-row b{flex:0 0 auto;min-width:86px;color:var(--color-tooltip-foreground,#fafafa);font-weight:600}" +
      ".tip .rt-row span{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".tip .rt-note{margin-top:7px;padding-top:6px;border-top:1px solid var(--color-border,transparent);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".ttabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px}" +
      ".ttab{cursor:pointer;padding:2px 10px;border-radius:999px;background:var(--color-tooltip-tag,#262626);" +
      "color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap;font-size:calc(var(--ui-font-size,14px) - 1px);" +
      "transition:background-color .12s ease-out,color .12s ease-out}" +
      ".ttab:hover{color:var(--color-tooltip-foreground,#fafafa);background:color-mix(in srgb,var(--color-tooltip-foreground,#fafafa) 12%,transparent)}" +
      ".ttab.on{background:color-mix(in srgb,var(--color-brand,#5ac8ff) 16%,transparent);color:var(--color-brand,#5ac8ff)}" +
      ".tbody{max-height:60vh;overflow:auto;scrollbar-width:thin}" +
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
      ".panel.zu-light{box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 12px 32px rgba(15,23,42,.14),0 2px 8px rgba(15,23,42,.08)}" +
      /* v81：反色底后 tip 的 inset 白高光在浅色主题（黑底 tip）上违和，浅色只调淡外阴影 */
      ".tip.zu-light{box-shadow:0 10px 28px rgba(15,23,42,.16),0 2px 6px rgba(15,23,42,.08)}" +
      ".zusage-exc.zu-light{box-shadow:0 12px 32px rgba(15,23,42,.14),0 4px 18px rgba(220,38,38,.1)}" +
      ".zu-light .exc{text-shadow:none}" +
      ".zu-light .ok{color:#0f9d6c}.zu-light .warm{color:#b6791a}.zu-light .hot{color:#d8482f}" +
      ".zu-light .sublive{color:#0c8a63;background:rgba(15,140,102,.12)}" +
      ".zu-light .xb-copied{color:#0c8a63}" +
      /* 减少动态偏好：关闭呼吸/闪烁与悬浮过渡 */
      "@media (prefers-reduced-motion:reduce){.exc,.dot{animation:none}" +
      ".it,.btn,.ttab,.panel label{transition:none}}";

    /* 结构：条撑满卡片宽后 .zu-main 占满剩余宽、条目+分隔线 space-between 均匀分布，
     * ⚙ 落在最右缘（内容超宽时分级收缩、极限右缘渐隐 .zu-clip）；面板 fixed 挂 body，
     * 由 position*Panel 按条矩形定位在条上方（v80 迁移，见挂载处注） */
    var bar = document.createElement("div");
    bar.className = "zusage-root";
    if (slot === 0) bar.id = "zusage-bar";
    bar.style.display = "none";   // 定位成功前不显示（避免占位）
    bar.innerHTML = '<span class="zu-main">…</span>' +
      '<span class="btn zu-gear">⚙</span>';
    var panel = document.createElement("div");
    panel.className = "panel zu-settings";
    function settingRow(input, title, note) {
      return '<label>' + input + '<span>' + title + '<em>' + note + '</em></span></label>';
    }
    /* 面板文案可随语言重建（事件走 panel 级委托，重建不丢监听） */
    function buildPanel() {
      var oldBody = panel.querySelector(".zu-settings-body");
      var scrollTop = oldBody ? oldBody.scrollTop : 0;
      panel.innerHTML =
      '<div class="zu-settings-head"><div class="phead">' + L("状态条设置", "Status bar settings") + '<span class="pver zu-settings-version"></span></div>' +
      '<button type="button" class="zu-settings-close" aria-label="' + L("关闭设置", "Close settings") + '">✕</button></div>' +
      '<div class="zu-settings-body" tabindex="0" role="region" aria-label="' + L("状态条设置选项", "Status bar settings options") + '">' +
      '<section class="zu-settings-section"><div class="cap">' + L("状态条显示", "Display items") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="checkbox" data-k="ctx">', L("上下文", "Context"), L("进度条与占用比例，颜色随用量变化", "Progress and usage percentage, colored by usage")) +
      settingRow('<input type="checkbox" data-k="turn">', L("本轮", "Current turn"), L("tokens、请求次数、耗时与首字延迟", "Tokens, requests, duration and first-token latency")) +
      settingRow('<input type="checkbox" data-k="win">', L("会话累计", "Session total"), L("当前会话的 tokens、轮数与请求次数", "Tokens, turns and requests in this session")) +
      settingRow('<input type="checkbox" data-k="tools">', L("工具调用", "Tool calls"), L("悬停查看各工具明细与错误", "Hover for per-tool details and errors")) +
      settingRow('<input type="checkbox" data-k="today">', L("今日合计", "Today's total"), L("今天所有会话的消耗", "Usage across all sessions today")) +
      settingRow('<input type="checkbox" data-k="sub">', L("子代理", "Sub-agents"), L("点击状态条上的子代理查看明细", "Click the bar item for sub-agent details")) +
      '</div></section>' +
      '<section class="zu-settings-section"><div class="cap">' + L("通用", "General") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="text" class="zu-ctxov" inputmode="numeric" aria-label="' + L("上下文窗口", "Context window") + '" placeholder="' + L("自动（按模型）", "Auto (model)") + '">', L("上下文窗口", "Context window"), L("留空自动识别，优先使用客户端数值", "Leave empty to detect automatically; prefer the client value")) +
      /* 万/亿开关只在中文界面出现（英文始终 K/M/B，见 fmt），因此文案不走 L() */
      (state.lang === "en" ? "" : settingRow('<input type="checkbox" class="zu-cn-num">', "中文单位（万/亿）", "token 数量以万/亿显示，默认开启")) +
      '<div class="zu-settings-langs"><label><input type="radio" name="zu-lang" value="zh"><span>中文</span></label>' +
      '<label><input type="radio" name="zu-lang" value="en"><span>English</span></label></div></div></section>' +
      '<section class="zu-settings-section"><div class="cap">' + L("回答统计", "Reply statistics") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="checkbox" class="zu-rate-line">', L("回答末尾追加统计行", "Append stats to each reply"), L("默认开启，下一次提问生效。包含速率（含思考）、首字延迟、输出量、生成耗时、段数峰值与会话累计。", "On by default; effective on the next prompt. Includes speed (with thinking), first-token latency, output, duration, segments/peak and session total.")) +
      '</div></section>' +
      '<section class="zu-settings-section"><div class="cap">' + L("插件更新", "Plugin updates") + '</div><div class="zu-settings-card">' +
      settingRow('<input type="checkbox" class="zu-auto-update">', L("自动更新", "Automatic updates"), L("每 24 小时检查并安装新版，默认开启", "Check and install every 24 hours; on by default")) +
      '<div class="zu-settings-detail"><div class="zu-update-actions"><button type="button" data-update="check">' + L("检查更新", "Check for updates") + '</button><button type="button" data-update="update">' + L("立即更新", "Update now") + '</button></div>' +
      '<div class="pnote zu-update-status" role="status" aria-live="polite"></div>' +
      '<div class="pnote">' + L("仅更新此插件。GitHub 来源会联网，本地目录来源只检查本地文件，不上传用量数据。", "Only this plugin is updated. GitHub sources use the network; directory sources check local files. Usage data is never uploaded.") + '</div></div></div></section>' +
      '<section class="zu-settings-section"><div class="cap">' + L("关于数据", "About the data") + '</div><div class="pnote">' +
      L("悬停状态条查看明细。数据源 ~/.zcode/cli/db/db.sqlite（只读），请求完成后才落库。", "Hover bar items for details. Data source ~/.zcode/cli/db/db.sqlite (read-only); data is written after requests complete.") + '</div></section></div>' +
      '<div class="zu-settings-foot"><button type="button" class="zu-settings-scroll"></button>' +
      '<button type="button" class="zu-settings-feedback">' + L("反馈问题", "Report an issue") + '</button></div>';
      panel.querySelectorAll('input[name=zu-lang]').forEach(function (r) {
        r.checked = state.lang === r.value;
      });
      /* 重建后回填全部控件状态（语言切换路径不走 syncPanel）：checkbox 按 state.show、
         上下文窗口输入框按 state.ctxOv——否则切语言后勾选态清空、首次点击语义反转 */
      panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
        cb.checked = !!state.show[cb.dataset.k];
      });
      var ovInput = panel.querySelector(".zu-ctxov");
      if (ovInput) ovInput.value = state.ctxOv;
      var cnBox = panel.querySelector(".zu-cn-num");
      if (cnBox) cnBox.checked = !!state.cnNum;
      syncUpdate();
      panel.querySelector(".zu-settings-body").scrollTop = scrollTop;
      syncSettingsScroll();
    }
    function syncSettingsScroll() {
      var body = panel.querySelector(".zu-settings-body");
      var button = panel.querySelector(".zu-settings-scroll");
      if (!body || !button) return;
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
      var height = Math.max(0, Math.floor(br.top - 18));
      var value = height + "px";
      if (panel.style.getPropertyValue("--zu-settings-height") !== value) panel.style.setProperty("--zu-settings-height", value);
      value = br.width + "px";
      if (panel.style.width !== value) panel.style.width = value;
      /* v80：面板 fixed 挂 body——视口坐标贴条上沿（原 absolute 语义 bottom:100%+10px），
       * 左缘随条、可视区内夹紧；top 用开启后的实测面板高，避免底部悬空/重叠。 */
      var left = Math.max(8, Math.min(Math.round(br.left), innerWidth - Math.round(br.width) - 8));
      if (panel.style.left !== left + "px") panel.style.left = left + "px";
      var top = Math.max(8, Math.round(br.top - panel.offsetHeight - 10));
      if (panel.style.top !== top + "px") panel.style.top = top + "px";
      syncSettingsScroll();
    }
    panel.addEventListener("scroll", syncSettingsScroll, true);
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") panel.classList.remove("open");
    });
    buildPanel();
    /* v80：面板挂 body（fixed 视口坐标），不再挂 bar——条长进输入卡片（overflow-hidden）
     * 内部后，absolute 面板会被卡片裁掉。同 .tip 挂 body 的先例；.zusage-panel 类供
     * 全局清理与 isOwnOverlay 命中。 */
    panel.className = "panel zu-settings zusage-panel";
    document.body.appendChild(panel);
    /* 子代理明细面板（v49）：与设置面板同款 .panel 机制，点击条目开关，互斥打开 */
    var subPanel = document.createElement("div");
    subPanel.className = "panel subp zusage-panel";
    document.body.appendChild(subPanel);
    /* 自绘 tooltip：向上弹出（v45 起配空中走廊，移入点击不再被移开即隐掐断）；取代原生 title（方向不可控，在窗口底边会朝下被遮挡） */
    /* 自绘 tooltip 挂 body（fixed 视口坐标）：挂 bar 内会被消息流的层叠上下文盖住（v31 实证） */
    var tip = document.createElement("div");
    tip.className = "tip zusage-tip-root";
    if (slot === 0) tip.id = "zusage-tip";
    tip.style.display = "none";
    document.body.appendChild(tip);
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
    }
    try {
      themeObserver = new MutationObserver(function () {
        var d = themeIsDark();
        if (d !== themeDark) { themeDark = d; applyTheme(); }
      });
      themeObserver.observe(rootEl, { attributes: true, attributeFilter: ["class"] });
    } catch (e) { }
    applyTheme();

    var $ = function (id) { return bar.querySelector(id); };
    var main = bar.querySelector(".zu-main"), gear = bar.querySelector(".zu-gear");

    /* ---------- 渲染 ---------- */
    function fmt(n) {
      n = n || 0;
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

    /* 显示顺序：本轮 → 上下文 → 会话 → 工具 → 今日 → 子代理；token 后带缓存命中率。
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
    function ioc(inp, out, cache, rea, cw) {   // 悬停明细行：输入/输出/缓存命中/缓存写入/思考
      return L("输入 ", "Input ") + fmt(inp) + L(" / 输出 ", " / Output ") + fmt(out) + L(" / 缓存命中 ", " / Cache read ") + fmt(cache) +
        (cw > 0 ? L(" / 缓存写入 ", " / Cache write ") + fmt(cw) : "") +
        (rea > 0 ? L(" / 思考 ", " / Thinking ") + fmt(rea) : "");
    }
    /* 结构化 tooltip（v67.1）：\x01 前缀标记 HTML 内容（drawTip 分流），行/脚注排版与
     * 回复末尾统计行 tooltip 同款；动态值一律过 ttEsc（innerHTML 安全，如工具名/错误文案） */
    function ttEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function ttH(t) { return '<div class="rt-h">' + ttEsc(t) + "</div>"; }
    function ttRow(k, v) { return '<div class="rt-row"><b>' + ttEsc(k) + '</b><span>' + ttEsc(v) + "</span></div>"; }
    function ttNote(v) { return '<div class="rt-note">' + ttEsc(v) + "</div>"; }
    /* 行内 SVG 线性图标（v54）：stroke 走 currentColor，颜色由 .ico 控制统一换色 */
    function ico(paths) {
      return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    }
    function html(d) {
      var sess = d.session || {}, lt = d.last_turn || {}, today = d.today || {}, last = d.last || {};
      var tls = d.tools || { total: 0, errors: 0, list: [] };
      var items = [], tips = [];
      function it(inner, tip, cls) { items.push('<span class="it' + (cls ? " " + cls : "") + '">' + inner + "</span>"); tips.push(tip || null); }
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
            : L("若这是 SSH 远程会话：客户端连过的远端工作区会自动被发现并查询（v12 零配置）；没查到时核对远端机已部署 zusage.py，或在 config.json 配置 remote 段（README「远程会话」；ssh 也可写成 argv 数组，docker exec / wsl / kubectl exec 等通道都能借道）",
                "If this is a remote SSH session: remote workspaces the client connected to are discovered and queried automatically (v12, zero config); if it's still missing, make sure zusage.py is deployed on the remote machine, or add the remote section to config.json (see README; ssh may also be an argv array, so docker exec / wsl / kubectl exec all work)")));
      }
      /* v73：生成速度——桥命中（本 pane 会话有 renderer 投影）时用它的估算/真实 tok/s，
       * 否则退回原 DB 最近一段值（与 state.rateLine 开关无关：桥不可用或开关关闭时
       * liveStatsCur 恒为空，自动走 db 分支，不影响这个本就独立于逐问速率行的指标）。
       * zuBarSpeedView 对"刚绑定/重绑时捞到的历史存量已完成轮次"返回 null——这种情况
       * 和"桥完全没命中"一视同仁，同样回退 DB/不渲染，不冒充"这个会话速度不可用"。
       * 二者互斥：绝不同时渲染两枚「速度」chip。 */
      var dbTps = last.tps || 0;
      var speedView = liveStatsCur ? zuBarSpeedView(liveStatsCur, bridge.handle && bridge.handle.charsPerToken) : null;
      if (speedView) {
        liveKindCur = "live";
        livePhaseCur = speedView.phase || "";
        liveIconCur = speedView.phase ? "think" : "bolt";   // v77.1：运行期一律动效脑（思考/正文/工具），完成态才回闪电
        it((speedView.phase ? zuIcoThinking() : ico('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>')) +
          '<span class="zu-live ' + speedView.cls + '">' + speedView.text + "</span>",
          "\x01" +
          ttH(L("生成速度", "Generation speed")) +
          ttRow(L("生成中", "While running"), L("按文本增量算出的字符/s，除以「每 token 字符数」估算 tok/s；该比例取自本会话最近一次完成的真实轮次，随每轮刷新（首轮无样本时用粗略默认值）", "estimated from the text-delta chars/s divided by a chars-per-token ratio; the ratio is calibrated from this session's most recently completed turn and refines each turn (a rough default is used before the first sample)")) +
          ttRow(L("完成后", "When done"), L("切换为本轮真实 tok/s：输出 tokens（含思考）÷ 模型生成时长；本轮缺口径时回退数据库最近一段值", "switches to this turn's real tok/s: output tokens (thinking incl.) ÷ model generation time; falls back to the latest DB segment when this turn's basis is missing")) +
          ttRow(L("档位", "Bands"), L("≥70 绿 · 40–70 黄 · <40 红（仅完成态）", "≥70 green · 40–70 yellow · <40 red (completed only)")) +
          ttNote(L("数据来自 renderer 会话状态（只读桥），实时更新，不经过本地数据库轮询；生成中的数值为字符增量估算", "Data comes from the renderer session state via the read-only bridge, updating live, independent of local database polling; running values are estimated from text deltas")));
      } else if (dbTps) {
        liveKindCur = "fallback";
        livePhaseCur = "";
        liveIconCur = "bolt";
        var tpsCls = dbTps >= 70 ? "ok" : dbTps >= 40 ? "warm" : "hot";
        it(ico('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>') +
          '<span class="zu-live ' + tpsCls + '">' + dbTps + '</span><span class="dim">t/s</span>',
          "\x01" +
          ttH(L("生成速度 · 最近一段", "Generation speed · latest segment")) +
          ttRow(L("口径", "Basis"), L("输出 tokens（含思考）÷ 生成耗时", "output tokens (thinking incl.) ÷ generation time")) +
          ttRow(L("档位", "Bands"), L("≥70 绿 · 40–70 黄 · <40 红", "≥70 green · 40–70 yellow · <40 red")) +
          ttNote(L("回答期间每段完成即刷新。回复末尾的统计行是整问加权均值，两者数值不同属正常",
            "Refreshes as each segment completes. The reply-end rate line is the whole-turn weighted average, so the two legitimately differ")));
      } else {
        liveKindCur = "none";
        livePhaseCur = "";
        liveIconCur = "";
      }
      if (state.show.ctx) {
        var cw = parseInt(state.ctxOv, 10) || d.native_ctx || d.context_window || 0;
        var pct = cw ? sess.ctx / cw * 100 : 0;
        var exc = excActive(sess);
        /* 占比档位分两套：窗口 ≥100 万时同一百分比的绝对 token 量大，40/60 提前预警；其余维持 70/85。 */
        var big = cw >= 1000000;
        var cls = exc ? "exc" : pct >= (big ? 60 : 85) ? "hot" : pct >= (big ? 40 : 70) ? "warm" : "ok";
        var bar = cw ? '<svg class="cbar" viewBox="0 0 24 24" aria-hidden="true"><circle class="cbar-track" cx="12" cy="12" r="9"/>' +
          '<circle class="cbar-value ' + cls + '" cx="12" cy="12" r="9" pathLength="100" stroke-dasharray="' +
          Math.max(0, Math.min(100, pct)).toFixed(1) + ' 100" transform="rotate(-90 12 12)"/></svg>' : "";
        it(bar + (cw ? '<span class="pct ' + cls + '">' + pct.toFixed(1) + "%</span>"
              : '<span class="v' + (exc ? " exc" : "") + '">' + fmt(sess.ctx) + "</span>"),
          "\x01" +
          ttH(L("上下文容量", "Context capacity")) +
          (cw ? ttRow(L("已用 / 窗口", "Used / window"), fmt(sess.ctx) + " / " + fmt(cw))
              : ttRow(L("已用", "Used"), fmt(sess.ctx) + L("（窗口容量未知）", " (window capacity unknown)"))) +
          ttRow(L("颜色档位", "Color bands"),
            (big ? L("≤40% 绿 · 40–60% 黄 · ≥60% 红", "≤40% green · 40–60% yellow · ≥60% red")
                 : L("<70% 绿 · 70–85% 黄 · ≥85% 红", "<70% green · 70–85% yellow · ≥85% red")) +
            L(" · 超限=亮红闪烁", " · over-limit = flashing red")) +
          (exc ? ttNote(L("⚠ 上下文超限：最近一次请求被拒（" + fmtTime(d.ctx_exc) + "），需压缩会话或新开会话",
                          "⚠ Over limit: the latest request was rejected (" + fmtTime(d.ctx_exc) + ") — compress or restart the session")) : ""));
      }
      if (state.show.turn) {
        it(ico('<path d="M23 4v6h-6"/><path d="M20.49 15A9 9 0 1 1 18.36 5.64L23 10"/>') +
          '<span class="v">' + fmt(lt.total) + "</span>" +
          (shrink ? "" : cachePct(lt.cache_read, lt.input)) +   // v66 超宽时命中率让位，明细仍在悬停 tooltip
          '<span class="dim">' + (lt.requests || 0) + L("次", " req") + "</span>" +
          ico('<path d="M6 3h12M6 21h12M8 3v3.5L12 11l4-4.5V3M8 21v-3.5L12 13l4 4.5V21"/>') +
          '<span class="dim">' + sec(last.duration_ms) + "</span>" +
          ico('<path d="M5 20v-5M12 20v-9M19 20V5"/>') +
          '<span class="dim">' + sec(last.ttft_ms) + "</span>",
          "\x01" +
          ttH(state.lang === "en"
            ? "Latest turn · " + (lt.requests || 0) + " requests"
            : "本轮 · " + (lt.requests || 0) + " 次请求") +
          ttRow(L("输入", "Input"), fmt(lt.input) +
            (lt.input > 0 && lt.cache_read > 0 ? L("（命中 " + Math.round(lt.cache_read / lt.input * 100) + "%）", " (" + Math.round(lt.cache_read / lt.input * 100) + "% cached)") : "")) +
          ttRow(L("输出", "Output"), fmt(lt.output) +
            (lt.reasoning > 0 ? L("（含思考 " + fmt(lt.reasoning) + "）", " (incl. " + fmt(lt.reasoning) + " thinking)") : "")) +
          (lt.cache_write > 0 ? ttRow(L("缓存写入", "Cache write"), fmt(lt.cache_write)) : "") +
          ttRow(L("耗时", "Time"), L("单次 ", "request ") + sec(last.duration_ms) + L(" · 首字 ", " · TTFT ") + sec(last.ttft_ms) + L(" · 轮总 ", " · turn ") + sec(lt.duration_ms)) +
          ((lt.tool_calls || lt.retries || lt.tool_errors)
            ? ttRow(L("工具", "Tools"), (lt.tool_calls ? lt.tool_calls + L(" 次调用", " calls") : "") +
                (lt.retries ? L(" · 重试 ", " · retries ") + lt.retries : "") +
                (lt.tool_errors ? L(" · 错误 ", " · errors ") + lt.tool_errors : "")) : ""));
      }
      if (state.show.win) {
        it(ico('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>') +
          '<span class="v">' + fmt(sess.total) + "</span>" +
          (shrink ? "" : cachePct(sess.cache_read, sess.input)) +   // v66 同上
          '<span class="dim">' + (sess.turns || 0) + L("轮 ", " turns · ") + (sess.requests || 0) + L("次", " req") + "</span>",
          "\x01" +
          ttH(L("会话累计 · 全部请求", "Session total · all requests")) +
          ttRow(L("输入", "Input"), fmt(sess.input) +
            (sess.input > 0 && sess.cache_read > 0 ? L("（命中 " + Math.round(sess.cache_read / sess.input * 100) + "%）", " (" + Math.round(sess.cache_read / sess.input * 100) + "% cached)") : "")) +
          ttRow(L("输出", "Output"), fmt(sess.output) +
            (sess.reasoning > 0 ? L("（含思考 " + fmt(sess.reasoning) + "）", " (incl. " + fmt(sess.reasoning) + " thinking)") : "")) +
          (sess.cache_write > 0 ? ttRow(L("缓存写入", "Cache write"), fmt(sess.cache_write)) : "") +
          ttRow(L("规模", "Scale"), (sess.turns || 0) + L(" 轮 · ", " turns · ") + (sess.requests || 0) + L(" 次请求", " requests") +
            (sess.tool_calls ? L(" · 工具 ", " · tools ") + sess.tool_calls : "") +
            (sess.retries ? L(" · 重试 ", " · retries ") + sess.retries : "")) +
          (d.code && (d.code.add || d.code.del)
            ? ttRow(L("代码变更", "Code changes"), "+" + (d.code.add || 0) + " / -" + (d.code.del || 0) +
                (d.code.files ? L("（" + d.code.files + " 文件）", " (" + d.code.files + " files)") : "")) : ""));
      }
      if (state.show.tools) {
        var toolRows = (tls.list || []).map(function (t1) {
          return ttRow(t1.name, t1.count + L(" 次 · ", " calls · ") + sec(t1.duration_ms) +
            (t1.errors ? L(" · 错误 ", " · errors ") + t1.errors : ""));
        }).join("");
        it(ico('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>') +
          '<span class="v">' + (tls.total || 0) + "</span>" +
          (tls.errors ? '<span class="eb">' +
            ico('<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>') +
            tls.errors + "</span>" : ""),
          "\x01" +
          ttH(state.lang === "en"
            ? "Tool calls · " + (tls.total || 0) + " total" + (tls.errors ? ", " + tls.errors + " errors" : "")
            : "工具调用 · 共 " + (tls.total || 0) + " 次" + (tls.errors ? " · 错误 " + tls.errors : "")) +
          (toolRows || ttNote(L("无工具调用记录", "No tool calls recorded"))));
      }
      if (state.show.today) {
        it(ico('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>') +
          '<span class="v">' + fmt(today.total) + "</span>",
          "\x01" +
          ttH(L("今日合计 · 今天所有会话", "Today · all sessions")) +
          ttRow(L("输入", "Input"), fmt(today.input) +
            (today.input > 0 && today.cache_read > 0 ? L("（命中 " + Math.round(today.cache_read / today.input * 100) + "%）", " (" + Math.round(today.cache_read / today.input * 100) + "% cached)") : "")) +
          ttRow(L("输出", "Output"), fmt(today.output) +
            (today.reasoning > 0 ? L("（含思考 " + fmt(today.reasoning) + "）", " (incl. " + fmt(today.reasoning) + " thinking)") : "")) +
          ttRow(L("请求", "Requests"), (today.requests || 0) +
            (today.retries ? L(" 次请求 · 重试 ", " requests · retries ") + today.retries : L(" 次", " requests"))));
      }
      if (state.show.sub && d.sub && (d.sub.total || d.sub.active)) {
        /* v50：悬停 tooltip 只放汇总 + 打开面板的提示；各子代理明细在点击弹出的
         * 固定面板里用页签切换（面板固定不随鼠标，页签点击没有几何问题） */
        it(ico('<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>') +
          '<span class="v">' + fmt(d.sub.total) + "</span>" +
          (d.sub.active ? '<span class="ok dot">●</span>' : ""),
          L("子代理：当前会话的后台子代理消耗（独立统计，不计入会话累计）", "Sub-agents: background sub-agent usage of the current session (tracked separately, not counted in the session total)") + "\n" +
          ioc(d.sub.input, d.sub.output, d.sub.cache_read, d.sub.reasoning, d.sub.cache_write) +
          L("，共 ", ", ") + (d.sub.requests || 0) + L(" 次", " requests in total") + (d.sub.active ? L(" · 运行中", " · running") : "") +
          "\n" + L("点击条目打开面板，查看每个子代理的具体消耗", "Click the item to open the panel with per-sub-agent details"), "zu-sub");
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
        tool_calls: 0, retries: 0, ctx: 0, updated: "", last_at: 0, ctx_exc: 0,
        last_turn: {requests: 0, retries: 0, tool_calls: 0, tool_errors: 0, input: 0, output: 0,
          reasoning: 0, cache_read: 0, cache_write: 0, total: 0, duration_ms: 0, ttft_ms: 0},
        last: {duration_ms: 0, ttft_ms: 0, model: "", tps: 0},
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
    }
    function bridgeTick() {
      if (inactive()) return;
      if (!state.rateLine || !TURN_STATS) { bridgeDetach(bridge.handle); updateLive(); return; }
      var sid = instSid || pickedSid || "";
      if (!sid) { bridgeDetach(bridge.handle); updateLive(); return; }
      if (bridge.handle) {
        if (bridge.handle.sid === sid) {
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
      var store = zuTryBindStore(sid);
      if (!store) { updateLive(); return; }   // 无桥 / 无匹配 session：降级（DB 路径不变），下轮再探
      var tracker = TURN_STATS.createTracker();
      var handle = { dead: false, sid: sid, store: store, tracker: tracker, alias: {}, off: null, charsPerToken: null };
      var off = TURN_STATS.subscribeStore(store, tracker, function () {
        if (inactive() || handle.dead) return;
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
        updateLive();
      });
      if (!off) {   // store 接口不合约定：退回降级
        try { store.off(); } catch (e) { }
        tracker.dispose();
        updateLive();
        return;
      }
      handle.off = off;
      bridge.handle = handle;
      updateLive();   // subscribeStore 首次同步回调已 ingest 初始快照，这里补挂实时段
    }
    function updateLive() {
      /* v73：合并「生成速度」chip 后，桥数据持续存在（生成中→完成，同一套
       * ico+'<span class="zu-live CLS">'+TEXT 结构）时只原地改 textContent/className，
       * 不重建条面（v33 原则）；桥「有/无」切换才会改变 chip 结构（图标出现/消失、
       * 退回 DB 的两段式拼接），需要整条重渲染。 */
      var h = bridge.handle;
      var stats = (state.rateLine && h && !h.dead && bridge.turnId) ? h.tracker.get(bridge.turnId) : null;
      if (h && stats && stats.complete && stats.outputTokens > 0 && stats.totalCharacters > 0) {
        h.charsPerToken = stats.totalCharacters / stats.outputTokens;   // c2t 自校准：本轮真实比例供下一轮估算用
      }
      var wasLive = liveKindCur === "live";
      var view = stats ? zuBarSpeedView(stats, h && h.charsPerToken) : null;
      liveStatsCur = stats;
      // 用 view（而非 stats）判定快速路径：stats 非空但 view 为 null（历史存量，见
      // zuBarSpeedView）时结构要切回降级拼法，必须走下面的整条重渲染，不能原地改字。
      // 阶段（思考↔工具↔正文）切换会更换 chip 的图标（动效脑/闪电），同样只能整条
      // 重渲染——原地改字换不了图标。
      var phase = view && view.phase ? view.phase : "";
      if (view && wasLive && phase === livePhaseCur) {
        liveTextCur = view.text;
        if (!liveEl) { render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 }); return; }
        if (liveEl.textContent !== view.text) liveEl.textContent = view.text;
        var cls = "zu-live " + view.cls;
        if (liveEl.className !== cls) liveEl.className = cls;
        return;
      }
      liveTextCur = view ? view.text : "";
      render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 });
    }
    bridge.timer = setInterval(bridgeTick, 2000);
    bridgeTick();

    function render(d) {
      state.data = d;
      var pc = null, p = null;
      if (instSid) {
        /* v61.1 分屏多实例：本条显示哪个会话由 composer 祖先链的 data-session-id 决定
         * （客户端每个 pane 自带该标记，比窗口级 mine 更准，绝不串 pane）；
         * 会话不在池里（还没拉取）就显示本会话 0 值 —— 绝不回退到别的会话（v34 原则）。 */
        pickedSid = instSid;
        p = sessionFor(d, instSid, pid);
        if (!p) p = stubFor(instSid);
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
      refreshWants();
      var h = html(view);
      /* 内容没变就不重建 DOM：泵每 1.5s 推送一次，无条件 innerHTML 会重建条面+重启呼吸灯
       * 动画+触发 tooltip 重画 = 悬停时周期性闪烁（v33 修复）。变化时才重建。 */
      if (h.s !== lastHtml) {
        lastHtml = h.s;
        main.innerHTML = h.s;
      }
      var els = main.querySelectorAll(".it");
      for (var i = 0; i < els.length; i++) els[i].__tip = h.tips[i] || null;
      liveEl = main.querySelector(".zu-live");   // v71：条面重建后实时段节点重挂（原地更新用）
      /* 数据刷新时正在悬停：接管同位置的新元素继续显示。只调位置不重画内容——
       * 数字每 1.5s 都在变，重画就是闪烁；旧文本保持到鼠标下次移动为止。 */
      if (tipFor) {
        var nu = null;
        if (tipFor === main) nu = main;
        else if (tipFor.__n === els.length) nu = els[tipFor.__idx];
        if (nu && nu.__tip) { tipFor = nu; positionTip(nu, true); } else hideTip(false, "render-orphan");
        /* 接管失败（条目结构变化）也受总闸保护：鼠标仍在条上时保持旧 tooltip，
         * 下一次 mousemove 会重新判定该显示哪一项 */
      }
      if (subPanel.classList.contains("open")) buildSubPanel(view.sub);   // 面板开着：随推送实时刷新
    }


    /* ---------- 自绘 tooltip：向上弹出（原生 title 方向不可控） ---------- */
    var tipFor = null, lastMoveAt = 0, tipSig = "";
    var mouseInBar = false;   // 鼠标是否悬停在条面/tooltip/面板上（最近一次 mousemove 判定）
    var tipGraceTimer = 0;    // 越顶宽限定时器（v46）
    var tipStats = { mv: 0, shows: 0, hides: 0, last: "", lastHide: "", corridor: 0, grace: 0 };   // 诊断：随 mount diag 回写
    /* 隐藏总闸（v33.3）：鼠标还在条面上时，任何路径（数据刷新接管失败/输入框重建/
     * 瞬时不可见判定）都不得隐藏 tooltip——只有鼠标真正离开条面（left-bar，force）
     * 或条面整体隐藏（force）才允许。 */
    function hideTip(force, cause) {
      if (!force && mouseInBar) { tipStats.lastHide = "blocked:" + (cause || "?"); return; }
      if (tipGraceTimer) { clearTimeout(tipGraceTimer); tipGraceTimer = 0; }
      if (tip.style.display !== "none") tip.style.display = "none";
      tipFor = null;
      tipSig = "";
      tipStats.hides++;
      tipStats.lastHide = cause || "?";
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
      tipSig = t;
      tip.innerHTML = '<div class="tbody"></div>';
      if (t.charCodeAt(0) === 1) tip.firstChild.innerHTML = t.slice(1);   // \x01 前缀 = 结构化 HTML（v67.1）
      else tip.firstChild.textContent = t;
      tip.style.display = "block";
      positionTip(el, keepTop);
    }
    function showTipFor(el) {
      tipFor = el;
      var its = main.querySelectorAll(".it");
      el.__idx = el === main ? -1 : Array.prototype.indexOf.call(its, el);
      el.__n = its.length;   // render 接管时校验条目数未变，数量变了 __idx 就不可信
      tipStats.shows++;
      tipStats.last = el === main ? "main" : String(el.textContent || "").slice(0, 12);
      drawTip(el, false);
    }
    /* 事件挂 document 捕获阶段（v32）：React/应用层可能在冒泡路上 stopPropagation，
     * 挂 main 的 mousemove 收不到（v31 实证：原生 title 有 hover、自绘 tip 无事件）。
     * stale() 守卫：热更新后旧实例监听器必须罢工，否则新旧两个 tip 同时工作。 */
    listenGlobal(document, "mousemove", function (e) {
      if (inactive()) return;
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
      var el = t.closest(".it");
      if (el) {
        if (el !== tipFor) showTipFor(el);
      } else if (tipFor) {
        /* 条面内非条目区（项间隔/分隔符/⚙）：保持当前 tooltip 不动（此处刻意无操作）。
         * 慢速移动时命中目标在条目↔空隙间反复跳，若此处切换内容/隐藏
         * 就是"出现一下立刻消失"的闪烁（v33.2，概览 tooltip 因此废除） */
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
    function syncUpdate() {
      var u = state.pluginUpdate;
      var active = !!(u && u.supported);
      var version = panel.querySelector(".zu-settings-version");
      version.textContent = active && u.currentVersion ? u.currentVersion : "";
      version.hidden = !version.textContent;
      var cb = panel.querySelector(".zu-auto-update");
      cb.checked = !!(u && u.auto);
      cb.disabled = !active;
      panel.querySelector('[data-update=check]').disabled = !active || !!u.busy;
      panel.querySelector('[data-update=update]').disabled = !active || !!u.busy || u.phase !== "available";
      var messages = {
        idle: L("尚未检测", "Not checked yet"),
        checking: L("正在检查更新…", "Checking for updates…"),
        available: L("发现新版本", "Update available"),
        current: L("当前已是最新版本", "Up to date"),
        updating: L("正在更新插件…", "Updating plugin…"),
        updated: L("插件已更新；请重开会话以加载新版插件组件", "Plugin updated; start a new session to load the new components"),
        error: L("更新失败：", "Update failed: ") + (u && u.error || ""),
      };
      var text = !active ? L("仅支持已安装的 zusage-marketplace 用户插件；更新通道未就绪时需先升级插件并重启 ZCode。", "Requires the installed user plugin from zusage-marketplace. Upgrade the plugin and restart ZCode if the update channel is not ready.") : messages[u.phase] || messages.idle;
      if (!active && u && u.error) text += "\n" + messages.error;
      if (active && u.currentVersion) text += "\n" + L("当前版本：", "Current version: ") + u.currentVersion;
      if (active && u.latestVersion) text += (u.channel === "release" ? L(" · Release 版本：", " · Release version: ") : L(" · 市场版本：", " · Marketplace version: ")) + u.latestVersion;
      if (active && u.channel) text += "\n" + (u.channel === "release" ? L("更新来源：GitHub 正式 Release（校验 ZIP 与 SHA256）", "Update source: stable GitHub Release (validated ZIP and SHA256)") : L("更新来源：本地目录市场", "Update source: local directory marketplace"));
      if (active && u.releaseUrl) text += "\n" + u.releaseUrl;
      if (active && u.checkedAt) text += "\n" + L("上次检测：", "Last checked: ") + new Date(u.checkedAt).toLocaleString();
      if (u && u.phase === "updating") text += "\n" + L("关闭自动更新仅阻止后续安装；已开始的安装会继续完成", "Turning automatic updates off stops future installs; an install already started will finish");
      if (u && u.restartRequired) text += "\n" + L("主进程或关闭热更新的文件已更新，需重启 ZCode", "Restart ZCode to load main-process updates or files with hot reload disabled");
      if (u && u.skipped && u.skipped.length) text += "\n" + L("保留本地热修（未覆盖）：", "Local edits preserved (not overwritten): ") + u.skipped.join(", ");
      panel.querySelector(".zu-update-status").textContent = text;
      /* 逐问速率行开关勾选态：state.rateLine 由主进程推送（或 change 时代乐观更新） */
      var rl = panel.querySelector(".zu-rate-line");
      if (rl) rl.checked = state.rateLine;
    }
    function syncPanel() {
      panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
        cb.checked = !!state.show[cb.dataset.k];
      });
      panel.querySelector(".zu-ctxov").value = state.ctxOv;
      var cnBox = panel.querySelector(".zu-cn-num");
      if (cnBox) cnBox.checked = !!state.cnNum;
      syncUpdate();
    }
    panel.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest(".zu-settings-close")) {
        panel.classList.remove("open");
        return;
      }
      if (e.target.closest && e.target.closest(".zu-settings-scroll")) {
        var body = panel.querySelector(".zu-settings-body");
        body.scrollTop += Math.max(1, Math.round(body.clientHeight * .8));
        syncSettingsScroll();
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
      var button = e.target.closest && e.target.closest("[data-update]");
      if (button && !button.disabled) pluginRequest(button.dataset.update);
    });
    gear.addEventListener("click", function (e) {
      e.stopPropagation();
      syncPanel();
      var opening = !panel.classList.contains("open");
      panel.classList.toggle("open");
      if (opening) {
        positionSettingsPanel();
        subPanel.classList.remove("open");   // 两面板同位重叠，互斥打开（v49）
        hideTip(true, "gear-open");   // 移向齿轮的路上可能触发过条目 tooltip，开面板时一并收掉
      }
    });
    panel.addEventListener("change", function (e) {
      var t2 = e.target;
      if (t2.classList.contains("zu-auto-update")) {
        pluginRequest("auto", t2.checked);
        return;
      }
      if (t2.classList.contains("zu-rate-line")) {
        /* 乐观更新勾选态，真值以主进程写 config.json 后回推的 rateLine 为准 */
        state.rateLine = t2.checked;
        scanRateLines();
        scanDeterministicLines();   // v71：关=撤下确定性历史行，开=立即重扫补行
        pluginRequest("rate-line", t2.checked);
        return;
      }
      if (t2.classList.contains("zu-cn-num")) {
        state.cnNum = t2.checked ? 1 : 0;
        persist();
        renderAll(false);
        return;
      }
      if (t2.name === "zu-lang") {
        state.lang = t2.value;
        persist();
        buildPanel();   // 面板自身文案随语言重建（含 radio 勾选态）
        rebuildExcBubble();
        renderAll(true);   // 条面单位与 tooltip 文案随语言刷新（含各实例面板文案重建）
        return;
      }
      if (t2.type === "checkbox") {
        state.show[t2.dataset.k] = t2.checked ? 1 : 0;
        persist();
      } else if (t2.classList.contains("zu-ctxov")) {
        state.ctxOv = t2.value.trim();
        persist();
      }
      renderAll(false);
    });
    listenGlobal(document, "mousedown", function (e) {
      /* v80：面板挂 body 后 bar.contains 不再覆盖面板自身，点面板内部不能关 */
      if (panel.classList.contains("open") && !bar.contains(e.target) && !panel.contains(e.target)) panel.classList.remove("open");
      if (subPanel.classList.contains("open") && !bar.contains(e.target) && !subPanel.contains(e.target)) subPanel.classList.remove("open");
    });

    /* ---------- 子代理明细面板（v49）：点击条目弹出的固定面板，替代悬停 tooltip ---------- */
    var subPanelTab = 0;   // 面板当前页签（0=汇总，i=第 i 个子代理）；数据刷新时保持
    function buildSubPanel(sub) {
      var list = (sub && sub.list) || [];
      if (subPanelTab > list.length) subPanelTab = 0;   // 列表变短则回汇总
      subPanel.innerHTML = "";
      var head = document.createElement("div");
      head.className = "phead";
      head.textContent = L("子代理明细", "Sub-agent details");
      var ver = document.createElement("span");
      ver.className = "pver";
      ver.textContent = L("独立统计 · 不计入会话累计", "Tracked separately · not counted in session total");
      head.appendChild(ver);
      subPanel.appendChild(head);
      if (!sub || (!sub.total && !sub.active)) {
        var empty = document.createElement("div");
        empty.className = "pnote";
        empty.textContent = L("当前会话没有子代理记录", "No sub-agent records in the current session");
        subPanel.appendChild(empty);
        return;
      }
      /* 页签行：汇总 + 每个子代理（复用 .ttabs/.ttab 样式）；动态名走 textContent 防注入 */
      var tabsRow = document.createElement("div");
      tabsRow.className = "ttabs";
      var labels = [L("汇总", "Summary")];
      list.forEach(function (s1) {
        /* task=派发时的 description（右侧"子智能体目录"同源）；无则退回 title/线路名 */
        var nm = String(s1.task || "").trim() || String(s1.title || "").trim() ||
          String(s1.agent || "sub").replace(/^zcode-/, "") + "…" + String(s1.sid).slice(-4);
        labels.push(nm.length > 12 ? nm.slice(0, 11) + "…" : nm);
      });
      labels.forEach(function (lb, i) {
        var tb = document.createElement("span");
        tb.className = "ttab" + (i === subPanelTab ? " on" : "");
        tb.setAttribute("data-i", String(i));
        tb.textContent = lb;
        tabsRow.appendChild(tb);
      });
      subPanel.appendChild(tabsRow);
      var body = document.createElement("div");
      body.className = "tbody";   // 复用 tooltip 内容容器的限高滚动
      subPanel.appendChild(body);
      function fillRow(row, s1) {
        var nm = String(s1.task || "").trim() || String(s1.title || "").trim() ||
          String(s1.agent || "sub").replace(/^zcode-/, "") + "…" + String(s1.sid).slice(-4);
        var n = document.createElement("div");
        n.className = "subname";
        n.textContent = nm + L("（", " (") + String(s1.agent || "subagent").replace(/^zcode-/, "") +
          " …" + String(s1.sid).slice(-4) + L("）", ")");
        if (s1.active) {   // 运行中徽章：动态名仍走 textContent，徽章是独立 span
          var live = document.createElement("span");
          live.className = "sublive";
          live.textContent = L("运行中", "running");
          n.appendChild(live);
        }
        var st = document.createElement("div");
        st.className = "substat";
        st.textContent = L("总消耗 ", "Total ") + fmt(s1.total) + L(" · ", " · ") + (s1.requests || 0) +
          L(" 次请求", " requests") + (s1.last ? L(" · 最后活动 ", " · last activity ") + fmtTime(s1.last) : "");
        var br = document.createElement("div");
        br.className = "substat dim";
        br.textContent = ioc(s1.input, s1.output, s1.cache_read, s1.reasoning, s1.cache_write);
        row.appendChild(n);
        row.appendChild(st);
        row.appendChild(br);
      }
      if (subPanelTab === 0) {
        var p1 = document.createElement("div");
        p1.className = "pnote";
        p1.textContent = ioc(sub.input, sub.output, sub.cache_read, sub.reasoning, sub.cache_write) +
          L("，共 ", ", ") + (sub.requests || 0) + L(" 次", " requests in total") +
          (sub.active ? L(" · 有子代理运行中", " · sub-agent running") : "");
        body.appendChild(p1);
        if (!list.length) {
          var p2 = document.createElement("div");
          p2.className = "pnote";
          p2.textContent = L("当前会话还没有子代理记录", "No sub-agent records in the current session yet");
          body.appendChild(p2);
        }
      } else {
        var row = document.createElement("div");
        row.className = "subrow";
        fillRow(row, list[subPanelTab - 1]);
        body.appendChild(row);
      }
    }
    function positionSubPanel() {
      if (!subPanel.classList.contains("open")) return;
      var item = bar.querySelector(".zu-sub");
      if (!item) return;
      var ir = item.getBoundingClientRect();
      var width = subPanel.offsetWidth;
      var left = ir.left + ir.width / 2 - width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      subPanel.style.left = Math.round(left) + "px";
      /* v80：fixed 挂 body，top 同设置面板——条上沿留 10px 缝 */
      subPanel.style.top = Math.max(8, Math.round(bar.getBoundingClientRect().top - subPanel.offsetHeight - 10)) + "px";
    }
    function toggleSubPanel() {
      var opening = !subPanel.classList.contains("open");
      subPanel.classList.toggle("open", opening);
      if (opening) {
        panel.classList.remove("open");   // 与设置面板互斥
        buildSubPanel(lastSub);
        positionSubPanel();
        hideTip(true, "sub-open");
      }
    }
    bar.addEventListener("click", function (e) {
      if (inactive()) return;
      if (e.target && e.target.closest && e.target.closest(".zu-sub")) {
        e.stopPropagation();
        toggleSubPanel();
      }
    });
    subPanel.addEventListener("click", function (e) {
      if (inactive()) return;
      var b = e.target && e.target.closest ? e.target.closest(".ttab") : null;
      if (!b) return;
      subPanelTab = +b.getAttribute("data-i") || 0;
      buildSubPanel(lastSub);   // 面板固定，切页签只换内容
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
    /* 模态弹窗打开判定（v62，issue #9）：Radix Dialog 往 body 挂一层「固定全屏 + 带底色 +
     * z-index 抬升」的遮罩（下拉菜单/选择器只设 body pointer-events:none、不挂遮罩——v61
     * 实测），且文档里同时存在 [role="dialog"]。此时聊天区整体不可交互，条必须整体收起：
     * 模型配置弹窗里的「推理参数映射」编辑框正好落在视口下半部，会被 findComposer 的
     * 启发式当聊天输入框，条就冒在弹窗里（用户 issue #9 截图）。
     * 自己的浮层（.zu-bar/.zu-back/.zu-sheet——移动端抽屉遮罩是同款全屏底色）不算。 */
    function modalOpen() {
      try {
        if (!document.querySelector('[role="dialog"]')) return false;
        var kids = document.body.children;
        for (var i = 0; i < kids.length; i++) {
          var el = kids[i];
          var cls = String(el.getAttribute && el.getAttribute("class") || "");
          if (el.id === "zusage-bar" || /(^|\s)zu-(bar|back|sheet)(\s|$)/.test(cls)) continue;
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
    function reallyVisible(el, ownOK) {
      if (!visible(el)) return false;
      if (inGhostSubtree(el)) return false;   // 设置页等幽灵壳：视觉已隐藏（v61）
      var r = el.getBoundingClientRect();
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
    var paddedCard = null, originalMargin = "";
    function releasePads() {
      if (!paddedCard) return;
      paddedCard.style.marginBottom = originalMargin;
      delete paddedCard.dataset.zuCardPad;
      paddedCard = null;
    }
    var CARD_MARGIN = "24px";
    function ensureCardPad() {
      if (!cardCache) return;
      if (paddedCard !== cardCache) {
        releasePads();
        paddedCard = cardCache;
        originalMargin = cardCache.style.marginBottom || "";
        cardCache.dataset.zuCardPad = originalMargin;
      }
      if (cardCache.style.marginBottom !== CARD_MARGIN) cardCache.style.marginBottom = CARD_MARGIN;
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
      if (!bar.classList.contains("zu-in")) return;
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

    function setComposer(el) {
      releasePads();   // 旧卡片的让位边距先还原（in-card 形态不需要让位带；兜底形态由 heavy 补回）
      composer = el;
      cardCache = null;
      cardMode = false;
      if (composer) {
        var c = cardOf(composer);
        if (c && c !== document.body) cardCache = c;
      }
      if (bar.classList.contains("zu-in")) mountBelowCard();   // 换卡先回落兜底形态，heavy 同 tick 重判挂载
    }
    function heavy() {
      if (inactive()) return;
      if (pid === "auto") {
        /* 兜底模式（主文档找不到带 pane 标记的输入框，shadow/iframe 场景）：沿用原
         * 单条查找链路（findComposer 含 deepFind 穿透），会话判定走 mine/pickCurrent */
        var el = findComposer();
        if (el && el !== composer) setComposer(el);
        else if (!el && composer && !composer.isConnected) setComposer(null);
      } else {
        /* v61.1 多实例：composer 由协调器按 pane 派发（wantedEl），本层只对账——
         * 元素被 React 重建/pane 关闭时清绑，等下一轮协调器重新派发 */
        if (wantedEl && wantedEl.isConnected) {
          if (wantedEl !== composer) setComposer(wantedEl);
        } else if (composer) {
          setComposer(null);
        }
        if (pendingSid !== instSid) {   // pane 切换了会话：立即按缓存 payload 重渲染
          instSid = pendingSid;
          if (state.data) render(state.data);
        }
      }
      if (!composer && slot === 0) collectDiag();   // 一直找不到输入框的窗口：周期性写环境诊断（everMounted 门防覆盖）
      if (composer) {
        if (!cardCache || !cardCache.isConnected) {
          var c = cardOf(composer);
          cardCache = c && c !== document.body ? c : null;
        }
        if (cardCache) {
          /* v80：优先挂输入卡片内部（工具行下）；无工具行回落 below-card 兜底 + 让位带 */
          cardMode = mountInCard();
          if (cardMode) releasePads();
          else { mountBelowCard(); ensureCardPad(); }   // React 重渲染可能重建卡片/重置内联边距，对比后再补
          nativeCtxVal = readNativeCtx(cardCache);
        } else if (cardMode) {
          mountBelowCard();
        }
      }
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
    function hideBar() {
      if (curDisplay !== "none") { bar.style.display = "none"; curDisplay = "none"; }
      /* v80：面板挂 body 不再随条隐藏，条隐时必须主动收起（否则面板悬空在已消失的条上方） */
      panel.classList.remove("open");
      subPanel.classList.remove("open");
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
        syncExcBubble();   // 超限气泡：显示/隐藏/贴条定位（内部自判状态，隐藏分支零开销）
        if (!composer || !composer.isConnected) { hideSince = 0; hideBar(); return; }
        if (cardMode) {
          /* v80 in-card 对账：React 整子树重挂（切会话 key 变化）会连外来节点一起丢，
           * 帧率级检查补挂；卡片本身被重建时 cardCache 断连，heavy 低频重找后再挂 */
          if (!bar.isConnected || bar.parentElement !== cardCache) {
            cardMode = mountInCard();
            if (!cardMode) mountBelowCard();
          }
        } else if (cardCache && cardCache.style.marginBottom !== CARD_MARGIN) {
          ensureCardPad();   // 流式期间 React 重置内联边距时立刻补回（仅 below-card 兜底形态）
        }
        var r = composer.getBoundingClientRect();
        var on = r.width > 60 && r.height > 14 && r.bottom > 0 && r.top < innerHeight &&
          !inGhostSubtree(composer) &&   // 设置页等幽灵壳（opacity-0/inert）：视觉已隐藏（v61）
          !modalOpen() &&                // v62：模态弹窗（模型配置等）打开时整体收起，弹窗内容不归条管（issue #9）
          (reallyVisible(composer, true) || coverOK(composer));
        if (!on) {
          if (slot === 0) diagHidden(r);   // 隐藏现场周期转储（v61，节流 4s；仅 0 号实例写，槽位共享）
          // 迟滞：连续 400ms 判定不可见才隐藏，瞬时失败（流式装饰层等）不闪
          if (!hideSince) hideSince = Date.now();
          if (Date.now() - hideSince > 400) { hideBar(); }
          return;
        }
        hideSince = 0;
        if (curDisplay !== "flex") { bar.style.display = "flex"; curDisplay = "flex"; }
        /* 悬浮在输入框视觉卡片正下方（v58 定位回归）：v55-v57 改贴窗口底，新对话 hero 页
         * 输入框垂直居中时条与输入框彻底脱钩（用户点名回退）。让位带 24px 比条高+顶缝
         * 短 ~7px，条底落进原生底部留白、距窗口底 ~7px —— v54 的"条下 15px 空白"不复发。
         * 水平仍与卡片左缘对齐 */
        var anchor = cardCache || composer;
        var ar = anchor.getBoundingClientRect();
        if (!cardMode) {
          /* 悬浮在输入框视觉卡片正下方（v58 定位回归）：v55-v57 改贴窗口底，新对话 hero 页
           * 输入框垂直居中时条与输入框彻底脱钩（用户点名回退）。让位带 24px 比条高+顶缝
           * 短 ~7px，条底落进原生底部留白、距窗口底 ~7px —— v54 的"条下 15px 空白"不复发。
           * 水平仍与卡片左缘对齐。v80 起仅 below-card 兜底形态走这里。 */
          var left = Math.round(ar.left);
          var top = Math.max(8, Math.min(Math.round(ar.bottom + 4), innerHeight - bar.offsetHeight - 2));
          if (left !== lastPos[0] || top !== lastPos[1]) {
            bar.style.left = left + "px"; bar.style.top = top + "px";
            lastPos = [left, top];
          }
          /* 宽度锁死卡片（v63 对齐，v66 收缩）：min=max-width = 卡片实测宽（border-box，
           * 外缘含边框正好压在卡片两缘上），任何内容量下条都与会话框两缘对齐。 */
          var minW = Math.max(60, Math.round(ar.width));
          if (bar.style.minWidth !== minW + "px") bar.style.minWidth = minW + "px";
          if (bar.style.maxWidth !== minW + "px") bar.style.maxWidth = minW + "px";
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
        var clip = main.scrollWidth > main.clientWidth + 1;
        if (clip !== fadeOn) { fadeOn = clip; main.classList.toggle("zu-clip", clip); }
        positionSettingsPanel();
        positionSubPanel();
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
            picked: pickedSid,
            exc: excOn ? (excGone ? "on-gone" : "on") : 0,
            href: String(location.href).slice(0, 120),
            lsVals: (function () {
              try {
                var out = [];
                Object.keys(localStorage).forEach(function (k) {
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

    syncPanel();
    if (state.data) render(state.data);   // 已有共享数据（后 spawn 的实例）直接渲染，不用零值覆盖
    else render({ session: {}, last_turn: {}, today: {}, context_window: 0 });

    function dispose() {
      if (instanceDisposed) return;
      instanceDisposed = true;
      clearInterval(heavyTimer);
      clearInterval(bridge.timer);   // v71：pane 销毁即停能力检测并释放 store 订阅
      bridgeDetach(bridge.handle);
      cancelAnimationFrame(frame);
      cancelTipGrace();
      if (excCopied) clearTimeout(excCopied.timer);
      if (themeObserver) themeObserver.disconnect();
      globalListeners.forEach(function (binding) {
        binding[0].removeEventListener(binding[1], binding[2], binding[3]);
      });
      globalListeners = [];
      releasePads();
      wantedEl = composer = cardCache = null;
      bar.remove();
      panel.remove();   // v80：面板挂 body，dispose 需单独摘除
      subPanel.remove();
      tip.remove();
      excBubble.remove();
    }
    var api = {
      pid: pid, slot: slot, dispose: dispose,
      attach: function (el, sid) {   // 协调器派发：pane 最靠下的可见输入框 + 其 data-session-id
        if (inactive()) return;
        wantedEl = el;
        pendingSid = sid || "";
        heavy();   // 立即对账（composer 重建/pane 关闭的最快收敛路径）
      },
      render: render,
      syncUpdate: syncUpdate,
      rebuild: function () { buildPanel(); rebuildExcBubble(); syncPanel(); },
      getSid: function () { return pickedSid || ""; },
      /* v71 确定性历史行数据源：DOM turn id（turnId 或 productTurnId 形态）→ tracker 统计 */
      statsFor: function (tid) {
        var h = bridge.handle;
        if (!h || h.dead || typeof tid !== "string") return null;
        var s = h.tracker.get(tid);
        if (!s) {
          var key = h.alias[tid];
          if (key && key !== tid) s = h.tracker.get(key);
        }
        return s;
      },
      liveEl: function () { return liveEl; },   // 测试缝：实时段节点引用
      liveIconKind: function () { return liveIconCur; },   // 测试缝：当前 chip 图标（think/bolt/空）
    };
    instances.push(api);
    refreshWants();
    return api;
  }
})();
