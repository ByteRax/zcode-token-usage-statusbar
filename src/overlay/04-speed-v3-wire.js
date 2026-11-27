  /* ==================== v384 生成速度 Tooltip V3：装配层（wire） ====================
   * 纯函数桥，替代 V2 的 spdRebuildOr/spdChartFor（已随 V2 块删除）。职责只有两件：
   * ①按时间 Tab 把 an 分发给 charts（recent/today/week）或 heat（month/all）；
   * ②spd3RebuildOr 镜像 V2 spdRebuildOr 契约——无轮表返回 null（调用方回退 V1 旧卡），
   *   有则返回闭包 (curHover, curSel) → "\x01"+整卡串，实例状态全部由调用方显式传入
   *   （IIFE 顶层函数读不到 spawnInstance 闭包，VM 切片纪律同 V2）。
   * SPD3_POOL 是最近一次重建的未筛选模型池（spd3AnalyzeCached 以 filt=auto 另算一份，
   * memo 命中近乎零成本），供筛选弹出层「全选」与搜索列表消费——与 SPD_PORTAL 同款
   * 「构建时写模块级变量」侧信道先例。
   * v479 月份导航（spec §28.5）：SPD3_MON 是最近一次重建所选卡的有效月份与导航下界
   * （an.mon），spd3MonthAct 是四类导航动作（前后切月/开关月历弹层/选月/切年）的单点
   * 状态机，06 主卡链与 01 精简 chip 链共用；spd3MonthOutside 是「点弹层之外即收」的
   * 判定（两链 tip 的 pointerdown 委托开头调用）；spd3MonthAnchor/spd3MonthFocus 供两链在
   * 各自 tip 上做弹层锚定与焦点归位。 */
  var SPD3_POOL = [];
  var SPD3_MON = null;
  function spd3ChartFor(an, sd, hoverIdx, o, mpopOpen) {
    if (!an) return "";
    /* v479：月历弹层开态经 o.mpopOpen 透传给胶囊的 aria-expanded（不改建方传入的 o） */
    if (an.period === "month")
      return spd3MonthHTML(an, hoverIdx, mpopOpen ? Object.assign({}, o || {}, { mpopOpen: true }) : o);
    if (an.period === "all") return spd3HistHTML(an, sd, hoverIdx, o);
    return spd3ChartHTML(an, hoverIdx, o);
  }
  function spd3RebuildOr(h, sd, sel, hover, liveOrSess, o, paneSess) {
    /* liveOrSess 为 v415 前 live 徽标的遗留参数（三调用点与接线测试锁签名），徽标
     * 删除后本函数与视图均不再消费，保留形参仅为兼容。 */
    if (!h || !h.turns || typeof h.turns.length !== "number" || !h.turns.length) {
      /* v261 同款：null 原因取证（typeof FATAL 守卫，VM 切片夹具无 FATAL 不炸）。 */
      try { if (typeof FATAL !== "undefined" && FATAL) FATAL.spdNull =
        { t: Date.now(), hType: typeof h, hasTurns: !!(h && h.turns),
          len: h && h.turns ? h.turns.length : -1 }; } catch (_) { }
      return null;
    }
    var sess = paneSess || null;
    var dftFilt = function () {
      return (typeof spd3FilterAuto === "function") ? spd3FilterAuto() : { mode: "auto", keys: null };
    };
    /* 串级 memo（M4/S10，闭包局部）：V3 卡不含逐拍走字（v415 起 live 徽标删除，
     * statusText 等实时态不再进产物），an 引用与呈现态全等的拍产物逐字节恒等——
     * 每拍重拼 259KB 级串纯浪费。
     * 键=[an 引用, hover, pop.open, pop.query, mpop.open, mpop.y]：交互路径
     * （柱 hover/chips/Tab/弹出层/月份导航/会话相位变化→an 引用变）自然失效。缓存命中须同时
     * 保鲜 SPD_PORTAL 侧信道（消费即清后重挂同一悬停卡，否则悬停中下一拍 Portal
     * 被清空收起）。 */
    var lastAn = null, lastTail = null, lastOut = "", lastPortal = "";
    return function (curHover, curSel) {
      var cur = curSel || sel;
      var hi = (typeof curHover === "number" ? curHover : hover);
      var core = { range: (cur && cur.range) || "recent", period: (cur && cur.period) || "recent",
        sid: (sess && sess.sid) || "", remote: !!(sess && sess.remote),
        filt: (cur && cur.filt) || dftFilt(),
        mon: (cur && cur.mon) || null };   /* v479：本月视图所选月（spec §28） */
      var an = spd3AnalyzeCached(h, sd, core);
      if (!an) return null;
      /* 未筛选池：仅显式筛选时另算（memo 多槽各自缓存，S10/B1），供 chips 全集与弹出层。
       * v479：与 an 同月（否则历史月下 chips「全选」会混入当前月的模型） */
      var poolAn = an;
      if (core.filt && core.filt.mode === "sel")
        poolAn = spd3AnalyzeCached(h, sd, { range: core.range, period: core.period,
          sid: core.sid, remote: core.remote, filt: dftFilt(), mon: core.mon }) || an;
      SPD3_POOL = (poolAn && poolAn.perModel) || [];
      SPD3_MON = an.mon || null;
      var pop = (cur && cur.pop) || { open: false, query: "" };
      /* v479：月历弹层态（top/right 锚定值随 open 重建写入，不进 tail） */
      var mpop = (cur && cur.mpop) || { open: false, y: 0 };
      var tail = [hi, pop.open ? 1 : 0, pop.query || "", mpop.open ? 1 : 0, mpop.y || 0].join("\u0001");
      if (lastAn === an && lastTail === tail) {
        SPD_PORTAL = lastPortal;
        return lastOut;
      }
      var chart = spd3ChartFor(an, sd, hi, o, mpop.open);
      var html = spd3CardHTML(an, {
          sel: core, hover: hi, o: o,
          pop: pop, mpop: mpop,
          pool: SPD3_POOL
        }).replace("<!--CHART-->", chart);
      lastAn = an; lastTail = tail; lastOut = "\x01" + html; lastPortal = SPD_PORTAL;
      return lastOut;
    };
  }
  /* v479（spec §28.5）月份导航动作——06 主卡链 spd3Activate 与 01 精简 chip 链
   * tpsSpd3Activate 共用的单点状态机（不各写一份分支）。按被点元素原地改 sel 的
   * mon / mpop / pop 并返回动作名，调用链各自负责重建、锚定与焦点：
   *   "shift" 前后切月（弹层已收）   "open" 月历弹层刚打开   "close" 月历弹层收起
   *   "pick" 选中某月（弹层已收）    "year" 弹层切年         ""=无动作
   * 无动作=不是月份导航元素，或落在边界外（按钮已 disabled；键盘/合成路径的兜底），
   * 或 SPD3_MON 缺席时的切月/选月/切年（不猜边界，只放行开关弹层）。
   * mon=an.mon：{y,m,cur,lo,hi}，lo/hi 为整数「年×12+月」闭区间。 */
  function spd3MonthHit(el) {
    return !!(el && (el.hasAttribute("data-sv3-mnav") || el.hasAttribute("data-sv3-mlabel") ||
      el.hasAttribute("data-sv3-mpick") || el.hasAttribute("data-sv3-myear")));
  }
  function spd3MonthAct(sel, el, mon) {
    if (!sel || !spd3MonthHit(el)) return "";
    if (!sel.mpop) sel.mpop = { open: false, y: 0 };
    var lo = mon ? mon.lo : 0, hi = mon ? mon.hi : -1;
    var nav = el.getAttribute("data-sv3-mnav");
    if (nav) {
      var mv = mon ? mon.y * 12 + mon.m + (nav === "next" ? 1 : -1) : NaN;
      if (!(mv >= lo && mv <= hi)) return "";
      sel.mon = { y: Math.floor(mv / 12), m: ((mv % 12) + 12) % 12 };
      sel.mpop.open = false;
      return "shift";
    }
    if (el.hasAttribute("data-sv3-mlabel")) {
      sel.mpop.open = !sel.mpop.open;
      if (!sel.mpop.open) return "close";
      sel.mpop.y = mon ? mon.y : new Date().getFullYear();
      if (sel.pop) { sel.pop.open = false; sel.pop.query = ""; }   /* 与模型筛选弹层互斥 */
      return "open";
    }
    var pick = el.getAttribute("data-sv3-mpick");
    if (pick) {
      var pv = parseInt(pick, 10);
      if (!(mon && pv >= lo && pv <= hi)) return "";
      sel.mon = { y: Math.floor(pv / 12), m: pv % 12 };
      sel.mpop.open = false;
      return "pick";
    }
    if (el.hasAttribute("data-sv3-myear")) {
      var ny = (sel.mpop.y || 0) + (el.getAttribute("data-sv3-myear") === "1" ? 1 : -1);
      if (!mon || ny < Math.floor(lo / 12) || ny > Math.floor(hi / 12)) return "";
      sel.mpop.y = ny;
      return "year";
    }
    return "";
  }
  /* v479（spec §28.5）点弹层之外即收：月历弹层开着且按下点在弹层与胶囊之外 → 置为收起
   * 并返回 true（只改状态不重建，由调用链重绘）；其余情形返回 false、不动状态。胶囊
   * 本身（切月、点月份文字开关）与弹层内部不算「之外」，交给 spd3MonthAct。 */
  function spd3MonthOutside(sel, el) {
    if (!sel || !sel.mpop || !sel.mpop.open || !el || typeof el.closest !== "function") return false;
    if (el.closest(".zu-sv3-mpop,.zu-sv3-mnav")) return false;
    sel.mpop.open = false;
    return true;
  }
  /* v489（spec §14.1）：模型筛选弹层「点弹层之外即收」——与 spd3MonthOutside 同款语义：
   * 筛选弹层开着且按下点在弹层与两枚 fopen 入口（「模型筛选」标签、+N）之外 → 收起、
   * 清搜索词并返回 true（只改状态不重建，由调用链重绘）。入口不算「之外」，交给
   * spd3Activate 的 toggle 分支——否则外点收起一次后 toggle 又把它翻转回打开。 */
  function spd3PopOutside(sel, el) {
    if (!sel || !sel.pop || !sel.pop.open || !el || typeof el.closest !== "function") return false;
    if (el.closest(".zu-sv3-fpop,[data-sv3-fopen]")) return false;
    sel.pop.open = false;
    sel.pop.query = "";
    return true;
  }
  /* v479：月历弹层锚定——顶到胶囊底缘 +6px、右缘对齐胶囊右缘（相对 .zu-sv3-root；
   * 与 fpop 的 pop.top 同款「打开时按实测几何写入」，内联覆写 CSS 默认位置）。
   * 任一侧取不到矩形保持 CSS 默认值。 */
  function spd3MonthAnchor(mpop, el, root) {
    var nav = el && el.closest ? el.closest(".zu-sv3-mnav") : null;
    if (!mpop || !nav || !root || typeof nav.getBoundingClientRect !== "function" ||
        typeof root.getBoundingClientRect !== "function") return;
    var nr = nav.getBoundingClientRect(), rr = root.getBoundingClientRect();
    mpop.top = Math.round(nr.bottom - rr.top + 6);
    mpop.right = Math.round(rr.right - nr.right);
  }
  /* v479：动作后的焦点归位（两链共用，容器=各自 tip；只在键盘路径调用）。open→弹层内
   * 选中月（所示年份无选中月则首个可用月）；year→重建后仍可用的年份按钮；其余→胶囊
   * 月份文字按钮（原按钮已随整卡重建销毁，不归位会让键盘焦点掉回 body）。
   * 指针路径不做焦点归位：按下触发的重建会销毁原节点，其后的 mousedown 落在已脱离的
   * 旧节点上、preventDefault 到不了，浏览器默认把焦点移回 body（2026-11-26 实机探针
   * 实证：程序化放进弹层的焦点 3ms 后即被拿走）；鼠标用户按 Esc 走全局兜底收整卡。
   * 两步查询：选择器列表按 DOM 序取首个，不能靠列表顺序表达优先级。 */
  function spd3MonthFocus(root, act) {
    if (!root || typeof root.querySelector !== "function") return;
    var popOpen = act === "open" || act === "year";
    var q1 = act === "open" ? ".zu-sv3-mpop .zu-sv3-mpick.on"
      : act === "year" ? ".zu-sv3-mpop [data-sv3-myear]:not([disabled])" : "[data-sv3-mlabel]";
    var q2 = act === "open" ? ".zu-sv3-mpop .zu-sv3-mpick:not([disabled])" : "[data-sv3-mlabel]";
    var n = root.querySelector(q1) || (popOpen ? root.querySelector(q2) : null);
    if (n && n.focus) n.focus();
  }
