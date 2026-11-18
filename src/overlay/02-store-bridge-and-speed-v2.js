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
    /* v233 估宽分级（v235 阈值随左卡 300→250px 重算）：剥掉 o.main 的 HTML 标签后按字符
     * 估宽（CJK/全角 1em、其余 0.6em，空白不计量），≤6.0em 默认单行大字（ui+22，容量
     * 222/36≈6.2em），≤9.0em 加 zu-speed-fit2（缩号允换行），更长加 zu-speed-fit3
     * （再缩号 + break-word）。分级类与 mainCls 并存；v371 起 CSS 双作用域
     * （.zu-speed-left 与 .zu-speed-hero）——legacy hero 的长工具动词此前永不命中会溢出。 */
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
  /* v291 前的本页存留注释见 git 历史；v384 起 V2 专属函数（spdUnpack/spdAggregate/
   * spdAnalyze/spdTabRow/spdHeadHTML/spdLeftHTML/spdCardHTML/spdChartHTML/spdRebuildOr/
   * speedCardV2HTML/月历与历史热力图）已删除，由 04-speed-v3-*.js 分片接替。 */
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

  var SPD_PORTAL = "";
  /* v384：V2 块删除时 spdLegendCardHTML 一并消失，但 01 分片 spdLegendTipShow（档位
   * 说明浮层，热力/柱图表头共用）仍消费它——按 fork/main 原文恢复（TPS_BANDS 倒序
   * 循环升序展示；Ultra 渐变圆点由 .zu-sv-li 作用域规则承载，CSS 仍留 06 分片）。 */
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
  /* 模型名按实际宽度缩小至不低于 10px，仍放不下时保留既有省略兜底。 */
  function fitModelNames(root) {
    if (!root || !root.querySelectorAll) return;
    var nodes = root.querySelectorAll(".zu-model-fit");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.style || !el.clientWidth) continue;
      el.style.removeProperty("font-size");
      var initial = parseFloat(getComputedStyle(el).fontSize) || 14;
      el.style.setProperty("white-space", "nowrap", "important");
      for (var size = Math.floor(initial); el.scrollWidth > el.clientWidth + 1 && size > 10; )
        el.style.setProperty("font-size", (--size) + "px", "important");
    }
  }
  /* 只按筛选栏和左卡量尺寸，不读取图表横滚内容，避免随历史桶数量撑宽。 */
  function spdFitTip(tip, reset) {
    if (!tip || !tip.querySelector || !tip.style) return;
    /* v384：V3 卡（.zu-sv3-root）自带 920×480 基准、--ui-font-size 缩放与内部横滚，
     * 这里只做视口兜底——清 V2 遗留 zoom、宽高钳进视口，并维护 __zuSpeedSize 供
     * tpsTip 链的「视口尺寸变化才重适配」判定；旧 .zu-sv-root 量测分支保留防热更
     * 过渡期旧卡在挂。 */
    var root = tip.querySelector(".zu-sv3-root");
    if (root) {
      var vw0 = window.innerWidth, vh0 = window.innerHeight;
      if (!(vw0 > 0 && vh0 > 0) || !root.getBoundingClientRect) return;
      root.style.zoom = "";
      root.style.maxWidth = Math.max(1, vw0 - 24) + "px";
      root.style.maxHeight = Math.max(1, vh0 - 16) + "px";
      tip.__zuSpeedSize = { w: 0, h: 0, left: 0, vw: vw0, vh: vh0, font: 0 };
      if (typeof tip.style.removeProperty === "function") {   /* VM 夹具 style 桩无该方法 */
        tip.style.removeProperty("--zu-sv-width");
        tip.style.removeProperty("--zu-sv-height");
        tip.style.removeProperty("--zu-sv-left-width");
      }
      return;
    }
    root = tip.querySelector(".zu-sv-root");
    if (!root) {
      tip.__zuSpeedSize = null;
      tip.style.removeProperty("--zu-sv-width");
      tip.style.removeProperty("--zu-sv-height");
      tip.style.removeProperty("--zu-sv-left-width");
      return;
    }
    var vw = window.innerWidth, vh = window.innerHeight;
    if (!(vw > 0 && vh > 0) || !root.getBoundingClientRect) return;
    var maxW = Math.max(1, vw - 24), maxH = Math.max(1, vh - 16);
    /* 速度卡以 14px 基准整体缩放；保留最小 80%，空间不足再交给扩高和滚动。 */
    var tipStyle = getComputedStyle(tip);
    var fontSize = parseFloat(tipStyle && tipStyle.getPropertyValue && tipStyle.getPropertyValue("--ui-font-size")) || 14;
    var scale = Math.max(0.8, Math.min(1, 14 / fontSize));
    root.style.zoom = String(scale);
    root.style.width = "100%";
    var previous = reset ? null : tip.__zuSpeedSize;
    if (previous && (previous.vw !== vw || previous.vh !== vh || previous.font !== fontSize)) previous = null;
    tip.style.setProperty("--zu-sv-width", Math.min(760, maxW) + "px");
    tip.style.setProperty("--zu-sv-left-width", (vw <= 780 ? 190 : 210) + "px");
    tip.classList.add("zu-sv-measure");
    var head = root.querySelector(".zu-sv-head"), left = root.querySelector(".zu-sv-left");
    var width = Math.min(760, maxW), baseLeft = vw <= 780 ? 190 : 210, leftWidth = baseLeft;
    try {
      if (head) width = Math.max(width, head.getBoundingClientRect().width + tip.getBoundingClientRect().width - root.getBoundingClientRect().width);
      if (left) {
        var title = left.querySelector(".zu-sl-title"), status = left.querySelector(".zu-sl-status");
        if (title && status) leftWidth += Math.max(0, title.scrollWidth - title.clientWidth);
        var stats = left.querySelectorAll(".zu-sl-stat b");
        for (var i = 0; i < stats.length; i++) {
          /* ×3：.zu-sl-stat 为三等分列，单列截断量换算为左卡总增量 */
          leftWidth = Math.max(leftWidth, baseLeft + Math.max(0, stats[i].scrollWidth - stats[i].clientWidth) * 3);
        }
        leftWidth = Math.min(320, Math.max(leftWidth, previous ? previous.left : 0));
        width = Math.max(width, 760 + leftWidth - baseLeft);
      }
      width = Math.min(maxW, Math.ceil(Math.max(width, previous ? previous.w : 0)));
      leftWidth = Math.min(leftWidth, Math.max(120, width - 120));
    } finally {
      tip.classList.remove("zu-sv-measure");
    }
    tip.style.setProperty("--zu-sv-width", width + "px");
    tip.style.setProperty("--zu-sv-left-width", leftWidth + "px");
    tip.classList.add("zu-sv-measure-height");
    var height = 300;
    try {
      height = Math.ceil(tip.getBoundingClientRect().height);
    } finally {
      tip.classList.remove("zu-sv-measure-height");
    }
    if (height > 300) height += 12;   // 留出标题、正文和底部统计的呼吸间距
    height = Math.min(maxH, Math.max(300, height, previous ? previous.h : 0));
    tip.style.setProperty("--zu-sv-height", height + "px");
    tip.__zuSpeedSize = { w: width, h: height, left: leftWidth, vw: vw, vh: vh, font: fontSize };
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
  /* v343（issue #321）：turn-text 回推诊断计数——占位行每轮常驻时此前零可观测，无从区分
   * 「主进程没回（旧冷文件/通道断）」与「回了但空（Python 失败/库没追上）」。页面存活期
   * 单调，经 FATAL.det.rt 落 diag-*.json（03 分片写入）。sent=已入队请求数；ok=非空交付
   * 入缓存；empty=空交付（旧主进程无原因标签时也落这里）；miss=入队后 RICH_TEXT_MISS_MS
   * 内无回执；stale=未匹配在途请求的回执（换代、单位切换、owner 消失等设计内淘汰）；
   * spawn、timeout、pyerr=新主进程标注的空交付原因（inject-main.cjs 需同版才细分，冷文件）。
   * v360（issue #321 后续诊断）：报告者 diag 实证 rt 全 0 而占位每轮常驻——请求根本没入队，
   * 此前的桶全是「入队之后」的，补收集/flush 门控的静默拒绝归因：noKey=富文本身份拒绝
   * （zuRichIdentity 空：scope 校验不过、无桥回退被远端证据 fail-closed 拒（#40 契约）——
   * 静态桥补装 pending（Windows asar 占用）期间 scope 属性缺席时的典型落点）；noSid=统计行
   * sessionId 与实例 sid 不一致；notCur=收集了但 flush 时非本实例活跃轮（含历史轮设计内
   * 只追活跃轮的跳过）；noInst=flush 时实例已消失（现行接线收集与 flush 同拍，仅直调可达，
   * 防御性保留）。四类共享轮键（pid|tid）去重，同一轮先后被多门拦截只记首因（入队解封或
   * 换代后才轮到下一个）——扫描 0.5s/拍会反复重收同一轮，逐拍累加会把「卡在门前的轮数」
   * 放大成心跳数；请求成功入队即解封该轮，同轮后续新失败可再计。 */
  var richTextDiag = { sent: 0, ok: 0, empty: 0, miss: 0, stale: 0, spawn: 0, timeout: 0, pyerr: 0,
    noKey: 0, noSid: 0, notCur: 0, noInst: 0 };
  var richTextBlocked = {};   // v360：静默拒绝已计过一次的轮键，入队即清（见 richTextDiag 注）
  function zuBlockOnce(dedupe, bucket) {
    if (!dedupe || richTextBlocked[dedupe]) return;
    capPut(richTextBlocked, dedupe, true, 256);   // 与 attempts/cache 同上限纪律；FIFO 淘汰后同轮可能重计一次，诊断计数允许近似
    richTextDiag[bucket] = (richTextDiag[bucket] || 0) + 1;
  }
  var richTextInFlight = {};   // epoch 记账：首个回执核销，同 epoch 重试刷新时限，超窗记 miss
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
    richTextBlocked = {};   // v360：换代后轮键作废，静默拒绝重新可计
    richTextInFlight = {};   // 在途作废：后续回执落 stale（设计内淘汰），不再计 miss
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
    if (!tid || !key || richTextCache[key] || (richTextAttempts[key] || 0) >= RICH_TEXT_MAX_ATTEMPTS) {
      /* v360：!key 即零入队（rt.sent 不动）——占位每轮常驻且 rt 全 0 的头号静默落点。 */
      if (!key && tid) zuBlockOnce(owner && owner.pid ? owner.pid + "|" + tid : "", "noKey");
      return;
    }
    var sid = stats && typeof stats.sessionId === "string" ? stats.sessionId : "";
    if (!sid || owner.getSid() !== sid) { zuBlockOnce(owner.pid + "|" + tid, "noSid"); return; }
    richTextWants[sid] = { owner: owner, tid: tid, key: key };
  }
  /* #321 诊断：入队后 RICH_TEXT_MISS_MS 内无任何回执记 miss（旧主进程无此动作处理器、
   * 通道断、主进程丢请求）。迟到回执若 pending 仍匹配则照常入缓存，只是不再计数（miss
   * 已记，ok/empty 只记窗口内的首个回执）。 */
  var RICH_TEXT_MISS_MS = 20000;   // 略大于主进程 15s 超时
  function zuSweepRichTextMiss() {
    var now = Date.now();
    for (var ep in richTextInFlight) {
      if (now - richTextInFlight[ep].at < RICH_TEXT_MISS_MS) continue;
      delete richTextInFlight[ep];
      richTextDiag.miss++;
    }
  }
  function zuFlushRichTextWants() {
    zuSweepRichTextMiss();
    for (var sid in richTextWants) {
      var w = richTextWants[sid];
      if (richTextCache[w.key]) continue;
      if (instances.indexOf(w.owner) < 0) { zuBlockOnce(w.owner.pid + "|" + w.tid, "noInst"); continue; }
      /* 只追当前活跃轮：--current 只返回该会话最新一轮，给历史轮发请求会缓存错轮文本
       * （历史轮保持占位，与 v75 起的实际生效行为一致）。v360：该门在 sent++ 之前，
       * 恒 false 时 sent 恒 0 且不留痕（报告者 rt 全 0 的候选落点之一），按轮键计一次。 */
      if (!w.owner.isCurrentTurn || !w.owner.isCurrentTurn(w.tid)) { zuBlockOnce(w.owner.pid + "|" + w.tid, "notCur"); continue; }
      var pending = richTextRequestTids[sid];
      if (!pending || pending.key !== w.key || pending.unit !== richTextUnitEpoch) {
        pending = { key: w.key, tid: w.tid, owner: w.owner, unit: richTextUnitEpoch, epoch: MY_GEN + ":" + (++richTextRequestEpoch), legacy: !pending && richTextUnitEpoch === 0 };
        richTextRequestTids[sid] = pending;
      }
      /* cn：万/亿开关当前值；为 0 时主进程给 token_rate.py 加 --no-cn-units */
      var req = { action: "turn-text", sid: sid, cn: cnUnits() ? 1 : 0, forceKmb: !!state.forceKmb, cost: state.cost === 0 ? 0 : 1, unitEpoch: pending.epoch };
      if (window.__zusagePluginRequests) window.__zusagePluginRequests.push(req);
      else window.__zusagePluginRequests = [req];
      capPut(richTextAttempts, w.key, (richTextAttempts[w.key] || 0) + 1, 256);
      richTextDiag.sent++;
      delete richTextBlocked[w.owner.pid + "|" + w.tid];   // v360：入队即解封同轮静默计数，后续新失败可再计
      richTextInFlight[pending.epoch] = { at: Date.now() };   // 同 epoch 重试刷新时限：miss 按「最近一次请求」起算
    }
    richTextWants = {};
  }
  /* 主进程回推：非空 = 富文本到位，写缓存并立即重扫（不等下一个 0.5s tick）；空 = 库里还没
   * 追到这一轮（或没有有效的提问时刻可推断），什么都不做——重试由 scanDeterministicLines
   * 的定时扫描自然驱动，这里绝不自建重试队列（否则两个驱动源叠加会绕开 attempts 上限）。
   * v343（issue #321）：回执按原因计数进 FATAL.det.rt——ok=非空入缓存；空交付按主进程
   * 原因标签分桶（spawn、timeout、pyerr，需主进程同版），无标签（旧主进程）与「库没追上」
   * 一并落 empty；未匹配任何在途请求的回执计 stale 不计 empty——换代、单位切换、owner
   * 消失都是设计内淘汰，不是查询失败。同 epoch 重试的多个回执只记首个（sent 已按请求
   * 计数，ok 与空桶是回执批级的下界，够定位「每轮常驻」的失败层）。 */
  window.__zusageDeliverTurnText = function (sid, text, unitEpoch, reason) {
    if (stale() || typeof sid !== "string") return;
    var pending = richTextRequestTids[sid];
    if (!pending || pending.unit !== richTextUnitEpoch || instances.indexOf(pending.owner) < 0 ||
        pending.owner.getSid() !== sid || zuRichKey(pending.owner, pending.tid) !== pending.key ||
        (unitEpoch == null ? !pending.legacy : unitEpoch !== pending.epoch)) {
      richTextDiag.stale++;
      return;
    }
    var key = pending.key, first = !!richTextInFlight[pending.epoch];
    if (first) delete richTextInFlight[pending.epoch];
    if (richTextCache[key]) return;
    if (typeof text !== "string" || !text) {
      if (!first) return;
      if (reason === "spawn" || reason === "timeout" || reason === "pyerr") richTextDiag[reason]++;
      else richTextDiag.empty++;   // 旧主进程无标签，或主进程明确的「库没追上」
      return;
    }
    if (first) richTextDiag.ok++;
    capPut(richTextCache, key, text, 256);
    delete richTextAttempts[key];
    scanDeterministicLines();
  };
