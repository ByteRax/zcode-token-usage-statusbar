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
      /* v298（用户拍板）：chip 主数字=最后一轮真实速度（去「均」前缀）；tooltip 左卡
       * 仍显示会话加权平均（status/speedValue 保留 avg 语义，两处各自成立） */
      return { cls: band.cls, band: band,
               text: (stats.tokenRate % 1 ? stats.tokenRate.toFixed(1) : String(stats.tokenRate)) + L(" t/s", " t/s"),
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
  var SPD_BARS_MAX = 18;   /* 2026-11-09 用户规格：最近 N 轮 16→18 */
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
    /* v273：智能紧凑——同年同月跨日不带年，跨月或跨年两端带年（v278 §5.4 校正：
     * 跨日右端此前恒带年，同月跨日被误加年份） */
    var p = function (d, wy) {
      return (wy ? d.getFullYear() + "/" : "") + spd2(d.getMonth() + 1) + "/" + spd2(d.getDate());
    };
    var hm = function (d) { return spd2(d.getHours()) + ":" + spd2(d.getMinutes()); };
    var sameDay = d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
    var crossMonth = d1.getFullYear() !== d2.getFullYear() || d1.getMonth() !== d2.getMonth();
    return sameDay ? p(d1, crossMonth) + " " + hm(d1) + " – " + hm(d2)
      : p(d1, crossMonth) + " " + hm(d1) + " – " + p(d2, crossMonth) + " " + hm(d2);
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
  /* 按 speed_history 对象引用缓存解包结果：updateLive 心跳/store 通知与悬停重编会反复经 spdAnalyze
   * 解包同一份轮表（6000 轮约 5ms/次，占整张速度卡生成的 95%）。同一帧内引用恒定；新帧是新 JSON
   * 对象自然失效，引用相等即内容相等，零陈旧风险。WeakMap 随帧对象回收，无需上限。
   * 结果只读：spdAnalyze/spdAggregate 只 filter/slice 出新数组、不改行对象；轮数守卫防原地追加。 */
  var SPD_UNPACK_MEMO = new WeakMap();
  function spdUnpack(h) {
    if (!h || !h.turns || typeof h.turns.length !== "number" || !h.sids || !h.snames) return null;
    var memo = SPD_UNPACK_MEMO.get(h);
    if (memo && memo.n === h.turns.length) return memo.res;
    var res = spdUnpackRaw(h);
    SPD_UNPACK_MEMO.set(h, { n: h.turns.length, res: res });
    return res;
  }
  function spdUnpackRaw(h) {
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
  function spdAggregate(rows, withNames) {
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
    var res = { v: out / (ms / 1000), out: out, ms: ms, i: i, o: o, n: n, turns: turns,
      models: ml.slice(0, 8), modelCount: ml.length, t0: isFinite(t0) ? t0 : 0, t1: t1,
      last: last, c: priced ? c : null, costFull: priced && costFull };
    /* 2026-11-09 用户规格：模型行悬停列表不省略——仅整体口径（withNames）额外产出
     * 全量模型名；逐柱/逐桶聚合不产（热力图数百桶 × 名单，白耗分配） */
    if (withNames) res.modelNames = ml.map(function (x) { return x.m; });
    return res;
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
    // 范围「最近」在该周期过滤之后取最近 16 个有效轮（时间窗先行、16 轮上限在后）——
    // 月历/历史图上 16 轮之前的同月日期会如实显示为无记录，稀疏说明已带轮数限定
    if (range === "recent") pool = pool.slice(-SPD_BARS_MAX);
    var items = [], unit = "", title = "";
    if (period === "recent") {
      pool = pool.slice(-SPD_BARS_MAX);
      for (var i = 0; i < pool.length; i++) {
        var agg = spdAggregate([pool[i]]);
        /* 2026-11-09 用户规格：柱底只显时分，v263 跨日日期行（dayLabel）移除——
         * 30px 柱宽下两行标签展示不全，月日由图表头范围行与悬停卡承载 */
        if (agg) items.push(Object.assign(agg, { label: spdShort(pool[i].t, "turn"),
          full: spdFull(pool[i].b) + " – " + spdFull(pool[i].t),
          a: pool[i].b, b: pool[i].t, single: true }));
      }
      unit = "turn";
      title = SPD_L("最近 " + items.length + " 轮 · 生成速度", "Last " + items.length + " turns · speed");
    } else {
      // 按时间粒度：今天恒按小时（含空桶）；v291 起其余时间 Tab（近 7 天/本月/全部）
      // 全部按日——「全部」切历史热力图需要完整日粒度桶，原跨度自适应月/季/年
      // 柱状图随热力图改造一并退役。
      if (pool.length) {
        if (period === "today") unit = "hour";
        else unit = "day";
        var buckets = {}, bkeys = [];
        for (var w = 0; w < pool.length; w++) {
          var bk = spdBucket(pool[w].t, unit);
          if (!buckets[bk]) { buckets[bk] = []; bkeys.push(bk); }
          buckets[bk].push(pool[w]);
        }
        bkeys.sort(function (x, y) { return x - y; });
        // 今天：00:00→当前小时全桶，无数据显空柱而非零速度；
        // v273：有效桶 ≤3 且全桶 ≥4 时默认聚焦有效时段。2026-11-07 用户规格：
        // 覆盖提示与「显示完整时间轴」切换按钮移除——聚焦即默认形态（收放
        // 条件读 sel.focus 的逻辑保留，当前无 UI 再改写该值）。
        if (period === "today") {
          bkeys = [];
          for (var hr = 0; hr <= new Date(now).getHours(); hr++) bkeys.push(todayStart + hr * 3600000);
          var fullKeys = bkeys.slice(0), realKeys = [];
          for (var fk = 0; fk < fullKeys.length; fk++) if ((buckets[fullKeys[fk]] || []).length) realKeys.push(fullKeys[fk]);
          if (sel.focus !== "full" && realKeys.length && realKeys.length <= 3 && fullKeys.length >= 4) bkeys = realKeys;
        }
        for (var bi = 0; bi < bkeys.length; bi++) {
          var bk2 = bkeys[bi], rows = buckets[bk2] || [], bg = spdAggregate(rows);
          var nb = spdNextBucket(bk2, unit);
          items.push(bg ? Object.assign(bg, { label: spdLabel(bk2, unit, true), full: spdFull(bk2) + " – " + spdFull(Math.min(nb, now)), a: bk2, b: nb, single: false })
            : { v: null, label: spdLabel(bk2, unit, true), full: spdFull(bk2) + " – " + spdFull(nb), a: bk2, b: nb, empty: true });
        }
      }
      /* v292（用户规格 2026-11-08）：标题去掉粒度词（每日/每小时）——「范围 · 时间 · 平均速度」
       * 三段式，粒度由图表形态自明（今天恒小时、其余恒日），不再进标题。 */
      var prefix = period === "today" ? SPD_L("今天", "Today") : period === "week" ? SPD_L("近 7 天", "Last 7 days")
        : period === "month" ? SPD_L("本月", "This month") : SPD_L("历史", "History");
      title = (range === "project" ? SPD_L("当前项目 · ", "Current project · ") : "") +
        prefix + SPD_L(" · 平均速度", " · average speed");
    }
    /* v295.7（用户规格）：恢复顺序时间（旧→新，最新柱在最右）——v290 的倒序撤销；
     * real 与峰值/最低/最新均按时间戳比较不受顺序影响；spanA/spanB 取自 pool。 */
    var real = items.filter(function (x) { return !x.empty; });
    var overall = spdAggregate(pool, true);
    var spanA = a || (pool.length ? pool[0].b : 0);
    var spanB = b || (pool.length ? pool[pool.length - 1].t : 0);
    if (period === "all" && pool.length) { spanA = pool[0].b; spanB = pool[pool.length - 1].t; }
    var peak = null, low = null, latest = null;
    for (var z = 0; z < real.length; z++) {
      if (!peak || real[z].v > peak.v) peak = real[z];
      if (!low || real[z].v < low.v) low = real[z];
      if (!latest || real[z].last > latest.last) latest = real[z];
    }
    /* 2026-11-07 用户规格：覆盖提示（v273 cov、v274「暂无足够数据」尾缀）、
     * 聚焦切换按钮与聚焦提示整体移除——图表头只留标题/单位/档位入口/时间范围。 */
    return { items: items, real: real, overall: overall, range: range, period: period, dim: "time",
      dims: ["time"], title: title, unit: unit, spanA: spanA, spanB: spanB,
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
  /* v278 顶部单行 Header：标题居左，范围/时间双 Tab 组成一个连续操作区整体靠右
   * （filter margin-left:auto），替代旧「标题一行 + 独立筛选行 + 时间胶囊」三段式；
   * 窄窗 flex-wrap 降级——Tab 组整体换到标题第二行仍右对齐，不裁剪不挤压。
   * 顶部时间胶囊删除，统计时间改由图表标题栏右端承载（spdChartHTML）。 */
  function spdHeadHTML(an) {
    var rl = { recent: SPD_L("最近", "Recent"), session: SPD_L("会话", "Session"),
      project: SPD_L("项目", "Project"), all: SPD_L("全部", "All") };
    var pl = { recent: SPD_L("最近", "Recent"), today: SPD_L("今天", "Today"),
      week: SPD_L("近 7 天", "7 days"), month: SPD_L("本月", "Month"), all: SPD_L("全部", "All") };
    return '<div class="zu-sv-head"><div class="zu-sv-title">' + spdEsc(SPD_L("生成速度", "Generation speed")) + "</div>" +
      '<div class="zu-sv-filter"><span class="zu-sv-flabel">' + spdEsc(SPD_L("范围", "Scope")) + "</span>" +
      spdTabRow("range", SPD_RANGES, an.range, rl) +
      '<span class="zu-sv-time"><span class="zu-sv-flabel">' + spdEsc(SPD_L("时间", "Time")) + "</span>" +
      spdTabRow("period", SPD_PERIODS, an.period, pl) + "</span></div>" +
      (an.notice ? '<div class="zu-sv-notice">' + spdEsc(an.notice) + "</div>" : "") + "</div>";
  }
  /* v298.2：左卡标题随时间 Tab（用户规格五命名）；EN 简洁对译 */
  function spdLeftTitle(period) {
    /* v303.4：跟随 SPD_BARS_MAX（此前硬编码 16 与柱数上限脱节） */
    var t = { recent: SPD_L("最近" + SPD_BARS_MAX + "轮", "Last " + SPD_BARS_MAX + " turns"), today: SPD_L("今天", "Today"),
      week: SPD_L("近7天", "Last 7 days"), month: SPD_L("本月", "This month"),
      all: SPD_L("近一年", "Last year") }[period] || SPD_L("平均", "Average");
    return t + SPD_L("平均速度", " · average speed");
  }
  /* 左统计卡：当前状态（实时估算与历史均值分离）/ 主均值 / 档位 / 峰值·最低·最新 */
  function spdLeftHTML(an, live) {
    var avg = an.overall ? an.overall.v : null;
    var bd = avg != null ? tpsBand(avg) : null;
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
    /* v278：标题行改「平均速度」+ 小号「历史统计」标识（规格 §7 第一层），原
     * .zu-sl-k 独立标签行删除（语义并入标题）；实时状态仍为行尾轻量标识不抢主数字 */
    /* v298.4（用户规格）：档位徽标下方展示当前筛选池对应模型名——与左卡均速同池
     * （an.overall.models 已按 Σ输出降序）；单模型直显全名，多模型显主模型 +N
     * （悬停带全列表）；池空不显该行。
     * 2026-11-09 用户实报：宿主内原生 title 不弹（生成期重建打断 + Electron 宿主
     * 对 title 气泡不可靠，同轮播分区先例）——改纯 CSS data-tip 伪元素气泡。
     * 同日用户规格：悬停列表**不省略**——用整体口径全量 modelNames（spdAggregate
     * withNames 产出），不再以 models 上限 8 截断加 …。 */
    var modelLine = "", modelFull = "";
    if (an.overall && an.overall.models && an.overall.models.length) {
      var mm = an.overall.models;
      modelLine = mm[0].m;
      var fullNames = (an.overall.modelNames && an.overall.modelNames.length)
        ? an.overall.modelNames : mm.map(function (m2) { return m2.m; });
      modelFull = fullNames.join(", ");
      if (an.overall.modelCount > 1) {
        modelLine += " +" + (an.overall.modelCount - 1);
      }
    }
    return '<div class="zu-speed-left zu-sv-left"><div class="zu-sl-status">' +
      /* v298.2（用户规格）：删「历史统计」标识，标题随时间 Tab 命名 */
      '<span class="zu-sl-title">' + spdEsc(spdLeftTitle(an.period)) + "</span>" +
      (spdLiveStatus ? '<span class="zu-sl-sub">' + spdEsc(spdLiveStatus) + "</span>" : "") + "</div>" +
      '<div class="zu-sl-body">' +
      '<div class="zu-sl-main"><span class="zu-sl-val' + (bd ? " " + bd.cls : " dim") + '">' + main +
      '</span><small class="zu-sl-unit">t/s</small></div>' +
      (bd ? '<div class="zu-speed-bandtag"><b class="' + bd.cls + '" style="font-weight:600">' +
        spdEsc(tpsBandText(bd)) + "</b></div>" : "") +
      /* v304.2（用户规格）：模型名升级为立方体 SVG 胶囊（与档位胶囊同视觉语言；
       * 多模型=「主模型 +N」，title 全列表不变） */
      (modelLine ? '<div class="zu-sl-model" data-tip="' + spdEsc(modelFull) + '" aria-label="' + spdEsc(modelFull) + '">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>' +
        '<span>' + spdEsc(modelLine) + "</span></div>" : "") +
      /* v263：口径公式行删除（规格点名「删除大段统计口径文字」，语义由图例 ⓘ title 承载）。
       * v307（用户规格）：「生成中估 X t/s」note 行删除——生成中估算只留标题旁
       * 「生成中（估算）」徽标，瞬时估算值不再与历史均值同卡并列（完成态会话均
       * 被误标「生成中估」的边界一并消失）。 */
      "</div>" +
      /* 2026-11-09 用户规格：单柱 zu-sl-solo 弱化删除——近 7 天/本月/全部聚合后常
       * 只有一根柱，峰值/最低/最新档位色恒与多柱态一致（CSS 规则同步删） */
      '<div class="zu-sl-stats">' + stat(SPD_L("峰值", "Peak"), an.peak) + stat(SPD_L("最低", "Low"), an.low) +
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
    /* v291：tv=悬停卡时间覆写（热力图日格显「2026-11-06 周五」整日形态），
     * 缺省保持聚合桶区间压缩逻辑不变 */
    var timeVal = item.tv || spdCompactRange(item.a, item.b);
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
  /* v280 P0：柱 hover 信息卡侧信道——spdChartHTML 构建时产出卡片 HTML（纯字符串，
   * 不触 DOM，VM 切片安全），宿主重编后经 spdHoverPortalSync 渲染到 body 级 Portal。
   * 每次构建都整体覆写（未悬停/空柱=空串），消费即清，跨帧/跨 tip 不串。 */
  var SPD_PORTAL = "";
  function spdChartLayout(n) {
    return {
      colPitch: 24,                                   /* v295.17：每柱 24px（柱 14 + 10px 间距） */
      spacerW: Math.max(240, n * 24 + 12),            /* plot 撑宽（少柱拉满容器、多桶横滚） */
      valEvery: Math.max(1, Math.ceil(n / 8)),        /* 柱顶数值稀疏化（防 16 柱重叠） */
      single: n === 1
    };
  }
  /* v291 图表标题栏/空态提取（原 spdChartHTML 内联段）：三态图表（柱状图/本月月历
   * 热力图/全部历史热力图）共用同一标题行（标题 + t/s 单位徽章 + 档位说明入口 +
   * 统计时间）与空态。sub=可选副题（历史热力图「按日聚合 · 自适应密度」）。
   * v272：维度下拉移除；v273：数据覆盖提示 + 聚焦/完整轴切换按钮；
   * v278：统计时间从顶部胶囊迁到标题栏右端（margin-left:auto + 钳边省略，
   * title 挂完整 YYYY-MM-DD HH:mm:ss 区间），单位紧随标题不再独占右端 */
  function spdChartHeadHTML(an, sub) {
    var ico = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>';
    /* v281→v285：档位说明入口（单位旁）。v285 换专用 Speed Bands SVG（细圆环 +
     * 三级递增速度柱，currentColor 继承按钮色态）替代通用问号；「单位：t/s」收为
     * 轻量「t/s」标签。data-sv-band 携带当前平均速度档位 cls——浮层高亮随整卡
     * 重编自动更新；空数据空串不高亮。 */
    var qico = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="8.15" stroke="currentColor" stroke-width="1.3" stroke-opacity="0.72"/>' +
      '<path d="M6.35 13.2V10.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.68"/>' +
      '<path d="M10 13.2V8.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.88"/>' +
      '<path d="M13.65 13.2V6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '</svg>';
    return '<div class="zu-sc-head"><span class="zu-sc-title">' + spdEsc(an.title) + "</span>" +
      '<span class="zu-sc-unit">t/s</span>' +
      '<button type="button" class="zu-sv-legend-btn" data-sv-band="' + (an.overall ? tpsBand(an.overall.v).cls : "") +
      '" aria-haspopup="true" aria-expanded="false" title="' + spdEsc(SPD_L("查看速度档位说明", "View speed bands")) +
      '" aria-label="' + spdEsc(SPD_L("查看速度档位说明", "View speed bands")) + '">' + qico + "</button>" +
      (sub ? '<span class="zu-sc-sub zu-hm-sub">' + spdEsc(sub) + "</span>" : "") +
      /* 2026-11-07 用户规格：覆盖提示/聚焦切换按钮/聚焦提示三段渲染删除 */
      '<span class="zu-sv-range" title="' + spdEsc(spdRangeFull(an.spanA, an.spanB)) + '">' + ico +
      "<span>" + spdEsc(spdRangeText(an.spanA, an.spanB)) + "</span></span></div>";
  }
  function spdChartEmptyHTML(head) {
    return '<div class="zu-speed-chart zu-sv-chart">' + head +
      '<div class="zu-sv-empty">' + spdEsc(SPD_L("当前筛选无有效速度数据", "No rated turns for this filter")) +
      '<span class="zu-sv-empty-hint">' + spdEsc(SPD_L("尝试选择更长时间范围", "Try a longer time range")) + "</span></div></div>";
  }
  /* 动态柱状图：细柱定宽居中、X 轴稀疏、Y 轴整洁刻度、无均值虚线。 */
  function spdChartHTML(an, hoverIdx, o) {
    var items = an.items, n = items.length;
    var L = spdChartLayout(n);
    SPD_PORTAL = "";
    var head = spdChartHeadHTML(an, "");
    if (!n) return spdChartEmptyHTML(head);
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
    var H = 148, valEvery = L.valEvery;
    /* v290 用户规格（2026-11-08）：每根柱都展示时间——字号降至 8px 后 5 字符标签
     * 在 30px 列宽内可容纳，稀疏化废弃 */
    /* v295.17（用户规格）：柱距 24px 下时间恢复每柱显示（相邻间隔 24px > 5 字符
     * 宽 ~21px，互不重叠）；2026-11-09 用户规格：跨日日期行（v263 dayLabel）移除，
     * 柱底恒单行时分（最近/今天 Tab），月日由图表头范围行承载 */
    function xShown() { return true; }
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
      var xTxt = "";
      if (xShown(c)) xTxt = "<b>" + spdEsc(it.label) + "</b>";
      cols += '<div class="zu-sc-col' + (isCur ? " cur" : "") + (it.empty ? " empty" : "") +
        (c === n - 1 ? " latest" : "") +   /* 顺序时间：最新柱在最右 */
        '" role="img" tabindex="0" data-i="' + c + '" aria-label="' +
        spdEsc(it.label + "，" + (it.empty ? SPD_L("无数据", "no data") : (it.v.toFixed(1) + " t/s"))) + '">' +
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
    /* v280 P0：信息卡不再内嵌 plot（被 .zu-sc-wrap 的 overflow 滚动容器裁剪）——
     * 改经 SPD_PORTAL 侧信道产出纯字符串，由宿主（showTpsTip/zuSpeedChartPick）
     * 渲染到 body 级 Portal 并按柱体屏幕坐标定位。空柱/未悬停产出空串=Portal 收起。 */
    SPD_PORTAL = (hoverIdx >= 0 && items[hoverIdx] && !items[hoverIdx].empty)
      ? spdCardHTML(items[hoverIdx], hoverIdx, o) : "";
    /* v273：plot 自适应——in-flow spacer 撑宽（多桶触发横滚），min-width 拉满容器，
     * 柱组 flex 居中；网格/Y 轴/hover 定位共享同一 plot 坐标系 */
    /* v295.13（用户规格）：首开滚到最右——时间顺序后最新数据在最右，窄容器横滚时
     * 默认定位最新（data-sv-end 由 drawTip/showTpsTip 既有分支消费，横滚记忆仍优先） */
    /* v295.18（用户规格）：Y 轴刻度列移出滚动容器（列宽 30px 固定，横向滚动时
     * 刻度不随滚，同「全部」热力图左侧星期列模式）；plot 不再留 30px 缩进 */
    return '<div class="zu-speed-chart zu-sv-chart">' + head +
      '<div class="zu-sv-plotrow"><div class="zu-sv-gutcol"><span class="zu-sc-gutter">' + gutter + '</span></div>' +
      '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu-sv-plot"><i class="zu-sv-spacer" style="width:' + L.spacerW + 'px"></i>' +
      '</span><span class="zu-sc-grid">' + grid + '</span>' +
      '<span class="zu-sv-bars">' + cols + "</span></div></div></div>";
  }
  /* v281：档位说明浮层内容（底部常驻图例移除，改由图表标题栏问号按钮承载）。
   * 十档自 TPS_BANDS 升序生成（颜色/星标/文案与柱体、chip 同源唯一事实）；
   * curCls=当前平均速度档位 cls（按钮 data-sv-band 随整卡重编自动更新），空串不高亮。
   * TPS_BANDS 数组为降序存储，倒序循环即得「从低到高」展示序（Goal §六）。 */
  function spdLegendCardHTML(curCls) {
    var out = '<div class="zu-sv-lg-head"><span class="zu-sv-lg-title">' + spdEsc(SPD_L("档位说明", "Speed bands")) +
      '</span><span class="zu-sv-lg-sub">' + spdEsc(SPD_L("生成速度 t/s", "Generation speed (t/s)")) + "</span></div>" +
      '<div class="zu-sv-lg-items">';
    for (var i = TPS_BANDS.length - 1; i >= 0; i--) {
      var b = TPS_BANDS[i], isCur = curCls && b.cls === curCls;
      out += '<span class="zu-sv-li' + (isCur ? " cur" : "") + '"><i class="' + b.cls + ' zu-legend-dot dot-c"></i><b class="' +
        b.cls + '">' + (b.lo === 0 ? "&lt;" + TPS_BANDS[TPS_BANDS.length - 2].lo : b.hi ? b.lo + "–" + b.hi : "≥" + b.lo) + "</b></span>";
    }
    return out + "</div>";
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
          /* remote 判定只认快照 remote 标（上游 v287 热修吸收，2026-11-07）：
           * 本地 scoped 行也带 workspace_identity，旧判定把本地 pane 误当远端，
           * 选「全部」被静默降级为本会话并显虚假远端提示 */
          sid: (sess && sess.sid) || "", remote: !!(sess && sess.remote) },
        live: live, segsHover: (typeof curHover === "number" ? curHover : hover),
        fmtTok: o.fmtTok, fmtCnt: o.fmtCnt, fmtMoney: o.fmtMoney };
      return "\x01" + speedCardV2HTML(opts);
    };
  }
  /* V2 整卡（v278 三层）：单行 Header（标题居左 + 双 Tab 组整体靠右）→ 左统计卡 +
   * 右动态图（统计时间在图表标题栏右端）→ 单行十档对照。到此结束。 */
  function speedCardV2HTML(o) {
    var an = spdAnalyze(o.speedHistory, o.sel || {});
    if (!an) return "";
    /* v279：根节点携带选择键（范围|时间）——横滚位置记忆的键（drawTip/showTpsTip
     * 同键回填、换键归零），不涉及统计口径 */
    var selKey = spdEsc(((o.sel && o.sel.range) || "") + "|" + ((o.sel && o.sel.period) || ""));
    return '<div class="zu-stat-tip zu-stat-tip--speed zu-sv-root" data-sv-key="' + selKey + '">' +
      /* v280 P1：tip 定宽（此前只钳 max-width，宽度=内容 max-content——plot spacer 与
       * 图表头文案随 Tab 变化让整卡在 ~700-960px 间跳动）。width+max-width 同值 !important
       * 压过 .tip 的 width:max-content 与 tpsTip 内联 max-width:520；border-box 含内边距。
       * v283：定宽值 960→800（用户规格，与宿主 dock 对齐构图协调）。 */
      /* v292（用户规格）：整卡高度固定 315px（border-box）——四种图表形态同高，
       * 切 Tab 不跳高；内部 .zu-sv-root 走 flex column，图表区吃剩余高度自适应 */
      /* v295（用户规格）：tooltip 收为 800×300 卡（v295.1 用户更正）。布局决策：
       * ①祖先层仍纯 height 链（tip 定高 300 → tbody 100% → 卡 100%，flex 只留卡自身）；
       * ②本月月历态（:has(.zu-hm-month)）隐藏左统计卡、热力图 6 列均分铺满全卡
       *   （30 天整除零空位；31 天末格跨行尾，永不留空隙）；
       * ③tbody 纵向 auto——其它 Tab（柱状/历史）内容超高时滚动而非裁切；
       * ④滚动条隐藏、ultra 抑制等既有契约不变。 */
      '<style>.zusage-tip-root:has(.zu-sv-root),.zusage-tps-tip:has(.zu-sv-root){width:min(760px,calc(100vw - 24px))!important;max-width:min(760px,calc(100vw - 24px))!important;height:300px!important;box-sizing:border-box!important;overflow:hidden!important}' +
      /* v303.1：tbody padding 归零——速度卡根带 zu-stat-tip 类会吃到 06:887 的
       * 12px 15px（与根 .tip 10px 13px 叠成 22/28 双层），与紧凑四卡统一后的
       * 单层 10px 13px 不一致（真机 segH 实证 tbody 278−24=root 254） */
      /* 右缘幽灵预留槽归零——基础 .tbody 的 scrollbar-gutter:stable（06:831，六卡
       * 纵滚防跳动用）在速度卡上是纯空耗：卡 height:100% 恒等于 tbody 高、纵向
       * 永不滚动，滚动条永不出现但 stable 仍恒预留 thin 滚动条槽位（QA 实测
       * tbody 732 vs 卡 721，右缘 11px 死空隙；devtools 元素高亮把该非内容区
       * 涂成 padding 绿，即用户实报「右侧绿色区域」）。速度卡不恢复 stable——
       * 极端字号溢出时 auto 让滚动条自然出现，代价仅该极端帧压缩 11px。 */
      '.zusage-tip-root:has(.zu-sv-root) .tbody,.zusage-tps-tip:has(.zu-sv-root) .tbody{height:100%!important;box-sizing:border-box!important;overflow:hidden!important;overflow-y:auto!important;padding:0!important;scrollbar-gutter:auto!important}' +
      /* v295.2：tpsTip 链生产上无 .tbody（直塞卡），该规则空匹配无害；harness 复刻页
       * 带 tbody 层，缺这条会让 tbody 高度悬空、卡 height:100% 回落内容高溢出被裁 */
      '.zusage-tip-root:has(.zu-sv-root) .zu-sv-root,.zusage-tps-tip:has(.zu-sv-root) .zu-sv-root{height:100%!important;min-height:0!important;box-sizing:border-box!important;display:flex;flex-direction:column;overflow:hidden}' +
      /* 300 小卡：本月态隐藏左统计卡（热力图铺满），其余 Tab 左卡纵排换行 */
      '.zusage-tip-root:has(.zu-sv-root) .zu-sv-root:has(.zu-hm-month) .zu-sv-filter{flex-wrap:wrap}' +
      /* 滚动条隐藏：新 Chromium（Fluent/overlay 滚动条）忽略 ::-webkit-scrollbar，
       * 标准属性 scrollbar-width 必须写在元素本身（写进伪元素无效，v293.1 曾写错位置） */
      '.zusage-tip-root .zu-sc-wrap,.zusage-tps-tip .zu-sc-wrap,.zu-sv-portal .zu-sc-wrap{scrollbar-width:none!important}' +
      '.zusage-tip-root .zu-sc-wrap::-webkit-scrollbar,.zusage-tps-tip .zu-sc-wrap::-webkit-scrollbar,.zu-sv-portal .zu-sc-wrap::-webkit-scrollbar{display:none!important}' +
      /* v298.1：柱状图 Y 轴刻度/网格锁定柱区基线。根因：V1 遗留 .zu-sc-gutter/
       * .zu-sc-grid 固定 height:160px 在 V2 只声明 top+bottom 时仍然胜出（V2 规则
       * 不含 height；绝对定位 top+height 同设时 bottom 被忽略）——刻度列被锁 160px
       * 下坠，「0」压进时间标签行（真机 segH 实测 gutter h=160、tick 0 与 x0 重叠）。
       * 此处显式 height:auto 让 top+bottom 生效，并按柱区基线对齐：
       * gutter bottom=21px（wrap padding 5 + x 标签 16，刻度「0」字形中心恰落在
       * 柱底基线）；grid bottom=16px（0% 网格线贴柱底基线，100% 贴绘图区顶）。
       * 仅作用柱状图——:not 排除月历/历史热力图两态（其 gutcol 语义不同）。 */
      '.zu-sv-chart:not(.zu-hm-month):not(.zu-hm-hist) .zu-sc-gutter{height:auto;top:5px;bottom:21px}' +
      '.zu-sv-chart:not(.zu-hm-month):not(.zu-hm-hist) .zu-sc-grid{height:auto;top:0;bottom:16px}</style>' +
      spdHeadHTML(an) +
      /* v281：底部常驻档位说明移除（连分割线/占位），档位说明改由图表标题栏问号
       * 浮层承载（spdLegendCardHTML + spdLegendTip）——TPS_BANDS 单一事实源不变，
       * 整卡高度由 Header 与统计主体决定，比旧版更紧凑。 */
      '<div class="zu-speed-body">' + spdLeftHTML(an, o.live) + spdChartFor(an, o.segsHover, o) + "</div></div>";
  }
  /* ---------- v291 热力图（本月月历 / 全部历史 GitHub 风格，用户设计图规格） ----------
   * 时间 Tab「本月」「全部」的柱状图替换为日粒度热力图：颜色仍走 TPS_BANDS 档位类
   * （currentColor 与柱体/图例同源，CSS 按 .zu-hm-cell 上的档位类给底色），数据复用
   * spdAnalyze 的日桶聚合（Σ有效输出 ÷ Σ生成窗口），绝不算术平均、绝不显 0 t/s。
   * 无记录日=中性格（无记录不等于零速）、未来日=弱化占位（无任何速度、不进统计）；
   * 格子带 data-i 指向本图 days 数组，悬停/焦点委托复用 .zu-hm-cell 契约（宿主侧
   * 选择器已扩展），悬停卡经 SPD_PORTAL 侧信道走 body 级 Portal（与柱状图同链）。 */
  var SPD_WD_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var SPD_WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var SPD_MO_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function spdWdLabel(wd) { return SPD_L(SPD_WD_ZH[wd], SPD_WD_EN[wd]); }
  function spdFmt1(v) { return v % 1 ? v.toFixed(1) : String(v); }
  /* v297 动态字号（用户 Goal）：在 6~14px 内选「能完整容纳的最大字号」。
   * 纯算术实现——等宽数字字宽 ≈ 0.64em（保守系数，含 k/M/小数点混合余量），
   * 行高 1.0；不做 DOM/Canvas 测量、不挂 ResizeObserver（格尺寸由宿主量测一次
   * 写 window.__zusageSpdMonRect，首帧用推导默认，字号变化不改变格尺寸故无振荡）。
   * 6px 仍超宽时进入紧凑数值格式（12.3k / 1.23M，完整精度走 Hover）。 */
  var SPD_HM_FS_MIN = 6, SPD_HM_FS_MAX = 14, SPD_HM_CHAR_W = 0.64;
  function spdHmFitFs(text, availW, availH) {
    var fs = Math.min(SPD_HM_FS_MAX,
      availW / Math.max(text.length, 1) / SPD_HM_CHAR_W,
      availH / 1.05);
    fs = Math.floor(fs * 2) / 2;   /* 0.5px 步进向下取 */
    return Math.max(SPD_HM_FS_MIN, Math.min(SPD_HM_FS_MAX, fs));
  }
  function spdCompactNum(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
    if (v >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return spdFmt1(v);
  }
  /* 完整日期形态（悬停卡时间行/aria）：2026-11-06 周五 / Fri 2026-11-06 */
  function spdDayFull(t, withWd) {
    var d = spdDate(t);
    return d.getFullYear() + "-" + spd2(d.getMonth() + 1) + "-" + spd2(d.getDate()) +
      (withWd ? SPD_L(" " + SPD_WD_ZH[d.getDay()], " " + SPD_WD_EN[d.getDay()]) : "");
  }
  /* 格子 aria：2026年11月6日 周五，平均速度 143.8 t/s，流畅；无记录日显式说明，
   * 绝不出现「0 t/s」。 */
  function spdCellAria(t, item) {
    var d = spdDate(t), wd = d.getDay();
    var dateTxt = SPD_L(d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + SPD_WD_ZH[wd],
      SPD_WD_EN[wd] + ", " + SPD_MO_EN[d.getMonth()] + " " + d.getDate() + " " + d.getFullYear());
    if (!item) return dateTxt + SPD_L("，无有效速度记录", ", no rated speed data");
    var b = tpsBand(item.v);
    return dateTxt + SPD_L("，平均速度 ", ", avg ") + spdFmt1(item.v) + SPD_L(" t/s", " t/s") +
      (b ? SPD_L("，" + b.zh, ", " + b.en) : "");
  }
  /* 日格悬停卡：有记录日复用 spdCardHTML 五字段（tv 覆写时间行为整日形态，模型/
   * Token/费用链逐字同源）；无记录日显式「当日无有效生成速度记录」；未来日「尚未
   * 开始」（月历占位格也可悬停，语义完整）。 */
  function spdDayCardHTML(entry, o, coverage) {
    var dayTxt = spdDayFull(entry.t, true);
    var head = '<div class="zu-sv-card" role="tooltip"><div class="zu-sv-crow"><span>' +
      spdEsc(SPD_L("日期", "Date")) + '</span><b title="' + spdEsc(spdRangeFull(entry.t, entry.t + 86400000)) + '">' +
      spdEsc(dayTxt) + "</b></div>";
    if (entry.state === "future")
      return '<div class="zu-sv-card zu-sv-card--void" role="tooltip"><div class="zu-sv-crow"><span>' +
        spdEsc(SPD_L("日期", "Date")) + "</span><b>" + spdEsc(dayTxt) + "</b></div>" +
        '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("状态", "Status")) + "</span><b>" +
        spdEsc(SPD_L("尚未开始", "Not started yet")) + "</b></div></div>";
    if (!entry.item)
      /* v296.1（用户规格）：无数据卡=日期 + 覆盖统计（共 N 天 · 其中 M 天有有效速度记录） */
      return head + '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("统计", "Coverage")) + "</span><b>" +
        spdEsc(coverage || SPD_L("当日无有效生成速度记录", "No rated speed data this day")) + "</b></div></div>";
    return spdCardHTML(Object.assign({}, entry.item, { tv: dayTxt }), 0, o);
  }
  /* 本月月历热力图：7 列（周日首列，与 spdBucket week 同基准）、行数=实际月历
   * （4～6 行，1 日前空位=透明对齐占位，不伪造上月日期）。有记录日=低饱和档位
   * 底（22% 混色）+ 左 3px 档位色条 + 日期 + 当日均速；已过无记录日=中性格 +
   * 日期；未来日=弱日期号（无速度无框，v294）。当日柔和内描边；≤2 天有记录时
   * 附一条轻量稀疏说明（规格 §9，不建新统计卡）。 */
  function spdMonthHeatmapHTML(an, hoverIdx, o) {
    SPD_PORTAL = "";
    var now = Date.now(), d0 = spdDate(now);
    var y = d0.getFullYear(), mo = d0.getMonth();
    /* v296.1（用户拍板）：7 列周日对齐日历——显示当月 1 日至今天；1 日前按星期日
     * 补齐占位；无数据日=中性弱底+弱日期号（补 0 与红底按用户要求移除），
     * 未来日期=弱日期号；行数=ceil((占位+天数)/7) */
    var nDays = new Date(y, mo + 1, 0).getDate();
    var cols = 7;
    var lead = new Date(y, mo, 1).getDay();
    var rows = Math.ceil((lead + nDays) / cols);
    var todayStart = new Date(y, mo, d0.getDate()).getTime();
    var byDay = {};
    for (var i = 0; i < an.items.length; i++) {
      var it0 = an.items[i];
      if (!it0.empty && it0.a) byDay[it0.a] = it0;
    }
    /* v293.1（用户拍板）：星期表头行舍弃——7 列日历结构不变，格子区直接平分卡高 */
    /* v295.4（用户拍板）：星期表头行恢复（周日..周六，7 列与格子对齐） */
    var wk = "";
    for (i = 0; i < 7; i++) wk += "<span>" + spdEsc(spdWdLabel(i)) + "</span>";
    var days = [], cells = "";
    if (lead) for (var p = 0; p < lead; p++) cells += '<i class="zu-hm-pad"></i>';
    /* v297 动态字号：宿主量测月历网格实际宽高（window.__zusageSpdMonRect，渲染后
     * 写回，缺省用 850 卡推导值），折算格宽/格高后按「速度文本长度分桶」计算
     * 每桶最大可容纳字号（6~14px、0.5px 步进、宽高双约束）——同长度同字号，
     * 不逐格 inline。6px 仍超宽的极端数值进紧凑格式（12.3k/1.23M，Hover 保完整）。
     * 极矮行档（6 行月）压日期字号与 padding，但不隐藏速度数字（v297 废止隐藏）。 */
    var mr = (typeof window !== "undefined" && window.__zusageSpdMonRect) || null;
    var calW = (mr && mr.w > 40) ? mr.w : 530, calH = (mr && mr.h > 40) ? mr.h : 161;
    var cellW = (calW - 6 * 8) / 7, cellH = (calH - (rows - 1) * 8) / rows;
    var padY = cellH >= 30 ? 4 : (cellH >= 24 ? 3 : 2);
    var padX = cellW >= 60 ? 6 : 4;
    var dateFs = cellH >= 30 ? 10 : (cellH >= 24 ? 8 : 7);   /* 日期让高给速度（速度优先级更高） */
    var availH = cellH - padY * 2 - dateFs * 1 - 1;
    var availW = cellW - padX * 2;
    var buckets = { f4: SPD_HM_FS_MAX, f5: SPD_HM_FS_MAX, f6: SPD_HM_FS_MIN };
    var fsByLen = {};
    var lenList = [4, 5, 6];
    for (i = 0; i < lenList.length; i++) {
      var L = lenList[i], fs = spdHmFitFs(new Array(L + 1).join("8"), availW, availH);
      if (fs <= SPD_HM_FS_MIN && availW < L * SPD_HM_FS_MIN * SPD_HM_CHAR_W) {
        var cTxt = spdCompactNum(L >= 6 ? 123456 : 12345);
        var cFs = spdHmFitFs(cTxt, availW, availH);
        buckets[L >= 6 ? "f6" : "f5"] = cFs;
        fsByLen[L] = { compact: true, fs: cFs };
        continue;
      }
      buckets[L >= 6 ? "f6" : (L >= 5 ? "f5" : "f4")] = fs;
      fsByLen[L] = { fs: fs };
    }
    var dFs = Math.max(6, dateFs);
    for (var dn = 1; dn <= nDays; dn++) {
      var ds = new Date(y, mo, dn).getTime();
      var it = byDay[ds] || null, bd = it ? tpsBand(it.v) : null;
      var future = ds > todayStart, cur = days.length === hoverIdx ? " cur" : "";
      var di = days.length;
      days.push({ t: ds, item: it, state: future ? "future" : (it ? "data" : "void") });
      if (future)
        cells += '<div class="zu-hm-cell fut' + cur + '" aria-hidden="true" data-i="' + di + '"><span class="zu-hm-d">' + dn + "</span></div>";
      else if (it) {
        var txt = spdFmt1(it.v), L2 = txt.length;
        if (fsByLen[L2] && fsByLen[L2].compact) { txt = spdCompactNum(it.v); L2 = txt.length; }
        var cls = L2 >= 6 ? "len6" : (L2 >= 5 ? "len5" : "len4");
        cells += '<div class="zu-hm-cell data ' + cls + (bd ? " " + bd.cls : "") + (ds === todayStart ? " zu-hm-today" : "") + cur +
          '" role="img" tabindex="0" data-i="' + di + '" aria-label="' + spdEsc(spdCellAria(ds, it)) + '">' +
          '<span class="zu-hm-d">' + dn + '</span><span class="zu-hm-v">' + spdEsc(txt) + "</span></div>";
      } else
        cells += '<div class="zu-hm-cell void' + (ds === todayStart ? " zu-hm-today" : "") + cur +
          '" role="img" data-i="' + di + '" aria-label="' + spdEsc(spdCellAria(ds, null)) + '">' +
          '<span class="zu-hm-d">' + dn + "</span></div>";
    }
    if (hoverIdx >= 0 && days[hoverIdx]) SPD_PORTAL = spdDayCardHTML(days[hoverIdx], o);
    var gridStyle = '--zu-hm-rows:' + rows + ';--hm-df:' + dFs + 'px;--hm-f4:' + buckets.f4 + 'px;--hm-f5:' + buckets.f5 +
      'px;--hm-f6:' + buckets.f6 + 'px;--hm-pady:' + padY + 'px;--hm-padx:' + padX + 'px';
    return '<div class="zu-speed-chart zu-sv-chart zu-hm-month">' + spdChartHeadHTML(an, "") +
      '<div class="zu-sc-wrap"><div class="zu-hm-cal"><div class="zu-hm-week">' + wk + "</div>" +
      '<div class="zu-hm-grid zu-hm-grid--mon" style="' + gridStyle + '">' + cells + "</div></div></div></div>";
  }
  /* 全部历史热力图（GitHub Contributions 版式）：一列=一周、一行=固定星期，从左到右
   * 最早→最新（最新在右）；颜色=当日均速档位（不是请求量/Token 量）。窗口=最早有效
   * 日所在周 → 当前周（含今日，尾部空周如实显示覆盖空档）；窗口外格子=透明占位，
   * 不计入统计。首开由宿主按 data-sv-end 滚到最右（§12.2 最新区域优先），横滚记忆
   * 键（data-sv-key）不变。列数上限 1040（约 20 年）纯 DOM 护栏——轮表本身有界
   * 6000 轮，跨窗截断已由 notice 显式披露。月标签按实际月份边界对齐（含新月那列），
   * 相邻标签不足 2 列时跳过防重叠；跨年在 1 月标签带年份。日期逐格用 Date 构造器
   * 推进（DST 安全，毫秒加法会把夏令时日的边界推出本地零点）。 */
  function spdHistoryHeatmapHTML(an, hoverIdx, o) {
    SPD_PORTAL = "";
    var todayStart = spdBucket(Date.now(), "day");
    var first = Infinity, lastData = 0, byDay = {};
    for (var i = 0; i < an.items.length; i++) {
      var it0 = an.items[i];
      if (!it0.empty && it0.a) { byDay[it0.a] = it0; if (it0.a < first) first = it0.a; if (it0.a > lastData) lastData = it0.a; }
    }
    if (first === Infinity) return spdChartEmptyHTML(spdChartHeadHTML(an, ""));
    /* v296（用户规格）：窗口=最近 365 天（today-364 → today，按周日起对齐补齐网格）；
     * 窗口内没有数据的日=中性格（#484848），更早的历史不在本视图。窗口外格子=透明
     * 星期对齐占位。 */
    var winStart = todayStart - 364 * 86400000;
    var winEnd = todayStart;
    var WEEK = 7 * 86400000;
    var w0 = spdDate(spdBucket(winStart, "week"));
    var wy = w0.getFullYear(), wmo = w0.getMonth(), wd0 = w0.getDate();
    /* 周数按周起点到周起点计算（窗口端点落在周内，直接相减会多算一周） */
    var weeks = Math.round((spdBucket(winEnd, "week") - spdBucket(winStart, "week")) / WEEK) + 1;
    /* DOM 护栏：>1040 周（约 20 年，现实库龄不可达——轮表本身有界 6000 轮）时右端
     * 对齐结束月、只渲染最近 1040 周；这是纯渲染钳制，spanA/左卡统计仍覆盖全池，
     * 与轮表 truncated 的 notice 披露是两回事 */
    if (weeks > 1040) {
      var w1 = spdDate(spdBucket(winEnd, "week"));
      wy = w1.getFullYear(); wmo = w1.getMonth(); wd0 = w1.getDate() - 1039 * 7;
      weeks = 1040;
    }
    var days = [], cells = "", labels = "", dayNums = "", lastMo = -1, lastLabCol = -9, dataN = 0;
    for (var w = 0; w < weeks; w++) {
      var cs = new Date(wy, wmo, wd0 + w * 7), ce = new Date(wy, wmo, wd0 + w * 7 + 6);
      /* 月标签：首列必标；其后本列右端出现新月即在该列标（月份只前进不回退），
       * 与上一标签间隔不足 2 列时跳过防文字重叠。端点按窗口钳制——首尾列可能
       * 越出窗口（星期对齐），越界部分的月份不得参与标签（v292 复验抓过 9月/12月
       * 幽灵标签） */
      var m1 = new Date(Math.max(cs.getTime(), winStart)).getMonth(),
          m2 = new Date(Math.min(ce.getTime(), winEnd)).getMonth();
      var lab = lastMo < 0 ? m1 : (m2 !== lastMo ? m2 : -1);
      if (lab >= 0 && w - lastLabCol >= 2) {
        lastMo = lab; lastLabCol = w;
        /* 年份取被标月份所在端点（同样经窗口钳制，防跨年首列取到越界周首的旧年） */
        var ly = new Date(lab === m2 && m2 !== m1 ? Math.min(ce.getTime(), winEnd) : Math.max(cs.getTime(), winStart)).getFullYear();
        labels += '<span class="zu-hm-ml" style="grid-column:' + (w + 1) + " / " + (w + 3 <= weeks ? "span 2" : "-1") + '">' +
          spdEsc(SPD_L((lab === 0 ? ly + "年" : "") + (lab + 1) + "月",
            lab === 0 ? SPD_MO_EN[lab] + " " + ly : SPD_MO_EN[lab])) + "</span>";
      }
      /* 列头日期数字（v293 设计图规格）：该列窗口内首日的日号 */
      var colFirst = Math.max(cs.getTime(), winStart);
      dayNums += '<span class="zu-hm-dn" style="grid-column:' + (w + 1) + ' / span 1">' +
        spd2(spdDate(colFirst).getDate()) + "</span>";
      for (var r = 0; r < 7; r++) {
        var ds = new Date(wy, wmo, wd0 + w * 7 + r).getTime();
        if (ds < winStart || ds > winEnd) { cells += '<i class="zu-hm-pad"></i>'; continue; }
        var it = byDay[ds] || null, bd = it ? tpsBand(it.v) : null;
        if (it) dataN++;
        var di = days.length, cur = di === hoverIdx ? " cur" : "";
        days.push({ t: ds, item: it, state: it ? "data" : "void" });
        cells += it
          ? '<div class="zu-hm-cell sq data' + (bd ? " " + bd.cls : "") + (ds === todayStart ? " zu-hm-today" : "") + cur +
            '" role="img" tabindex="0" data-i="' + di + '" aria-label="' + spdEsc(spdCellAria(ds, it)) + '"></div>'
          : '<div class="zu-hm-cell sq void' + (ds === todayStart ? " zu-hm-today" : "") + cur +
            '" role="img" data-i="' + di + '" aria-label="' + spdEsc(spdCellAria(ds, null)) + '"></div>';
      }
    }
    /* v296.1（用户规格）：覆盖统计不再单独成行，改随无数据格的悬停卡展示。
     * 须先于 SPD_PORTAL 赋值计算（review 修复：原写在 Portal 之后，var 提升致
     * 实参恒 undefined，覆盖统计静默退化为兜底文案）；分母以窗口起点与首数据日
     * 的较晚者起算，与网格可视窗口同口径（首数据日早于 365 天窗口时不虚增天数）。 */
    var totalDays = Math.round((todayStart - Math.max(first, winStart)) / 86400000) + 1;
    var coverage = SPD_L("共 " + totalDays + " 天 · 其中 " + dataN + " 天有有效速度记录",
      totalDays + " days in total · " + dataN + " with rated speed data");
    if (hoverIdx >= 0 && days[hoverIdx]) SPD_PORTAL = spdDayCardHTML(days[hoverIdx], o, coverage);
    var wd = "";
    for (i = 0; i < 7; i++) wd += "<span>" + spdEsc(spdWdLabel(i)) + "</span>";
    return '<div class="zu-speed-chart zu-sv-chart zu-hm-hist">' + spdChartHeadHTML(an, "") +
      '<div class="zu-hm-outer"><div class="zu-hm-wds">' + wd + "</div>" +
      '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu-hm-scroll" style="--zu-hm-w:' + weeks + '">' +
      '<div class="zu-hm-months" style="--zu-hm-w:' + weeks + '">' + labels + "</div>" +
      '<div class="zu-hm-days" style="--zu-hm-w:' + weeks + '">' + dayNums + "</div>" +
      '<div class="zu-hm-grid zu-hm-grid--hist" style="--zu-hm-w:' + weeks + '">' + cells + "</div></div></div></div>";
  }
  /* v291 图表分发（§3.1 切换规则）：本月=月历热力图、全部=历史热力图，
   * 最近/今天/近 7 天保持原柱状图。 */
  function spdChartFor(an, hoverIdx, o) {
    if (an.period === "month") return spdMonthHeatmapHTML(an, hoverIdx, o);
    if (an.period === "all") return spdHistoryHeatmapHTML(an, hoverIdx, o);
    return spdChartHTML(an, hoverIdx, o);
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
