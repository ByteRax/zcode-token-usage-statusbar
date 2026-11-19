  /* ==================== v384 生成速度 Tooltip V3：装配层（wire） ====================
   * 纯函数桥，替代 V2 的 spdRebuildOr/spdChartFor（已随 V2 块删除）。职责只有两件：
   * ①按时间 Tab 把 an 分发给 charts（recent/today/week）或 heat（month/all）；
   * ②spd3RebuildOr 镜像 V2 spdRebuildOr 契约——无轮表返回 null（调用方回退 V1 旧卡），
   *   有则返回闭包 (curHover, curSel) → "\x01"+整卡串，实例状态全部由调用方显式传入
   *   （IIFE 顶层函数读不到 spawnInstance 闭包，VM 切片纪律同 V2）。
   * SPD3_POOL 是最近一次重建的未筛选模型池（spd3AnalyzeCached 以 filt=auto 另算一份，
   * memo 命中近乎零成本），供筛选弹出层「全选」与搜索列表消费——与 SPD_PORTAL 同款
   * 「构建时写模块级变量」侧信道先例。 */
  var SPD3_POOL = [];
  function spd3ChartFor(an, sd, hoverIdx, o) {
    if (!an) return "";
    if (an.period === "month") return spd3MonthHTML(an, hoverIdx, o);
    if (an.period === "all") return spd3HistHTML(an, sd, hoverIdx, o);
    return spd3ChartHTML(an, hoverIdx, o);
  }
  function spd3RebuildOr(h, sd, sel, hover, liveOrSess, o, paneSess) {
    if (!h || !h.turns || typeof h.turns.length !== "number" || !h.turns.length) {
      /* v261 同款：null 原因取证（typeof FATAL 守卫，VM 切片夹具无 FATAL 不炸）。 */
      try { if (typeof FATAL !== "undefined" && FATAL) FATAL.spdNull =
        { t: Date.now(), hType: typeof h, hasTurns: !!(h && h.turns),
          len: h && h.turns ? h.turns.length : -1 }; } catch (_) { }
      return null;
    }
    var sess = paneSess || null;
    var live = liveOrSess || null;
    var dftFilt = function () {
      return (typeof spd3FilterAuto === "function") ? spd3FilterAuto() : { mode: "auto", keys: null };
    };
    /* 串级 memo（M4/S10，闭包局部）：V3 卡不含逐拍走字（live 只进 statusText 状态
     * 词），an 引用与呈现态全等的拍产物逐字节恒等——每拍重拼 259KB 级串纯浪费。
     * 键=[an 引用, hover, pop.open, pop.query, live.statusText]：交互路径
     * （柱 hover/chips/Tab/弹出层/会话相位变化→an 引用变）自然失效。缓存命中须同时
     * 保鲜 SPD_PORTAL 侧信道（消费即清后重挂同一悬停卡，否则悬停中下一拍 Portal
     * 被清空收起）。 */
    var lastAn = null, lastTail = null, lastOut = "", lastPortal = "";
    return function (curHover, curSel) {
      var cur = curSel || sel;
      var hi = (typeof curHover === "number" ? curHover : hover);
      var core = { range: (cur && cur.range) || "recent", period: (cur && cur.period) || "recent",
        sid: (sess && sess.sid) || "", remote: !!(sess && sess.remote),
        filt: (cur && cur.filt) || dftFilt() };
      var an = spd3AnalyzeCached(h, sd, core);
      if (!an) return null;
      /* 未筛选池：仅显式筛选时另算（memo 多槽各自缓存，S10/B1），供 chips 全集与弹出层。 */
      var poolAn = an;
      if (core.filt && core.filt.mode === "sel")
        poolAn = spd3AnalyzeCached(h, sd, { range: core.range, period: core.period,
          sid: core.sid, remote: core.remote, filt: dftFilt() }) || an;
      SPD3_POOL = (poolAn && poolAn.perModel) || [];
      var pop = (cur && cur.pop) || { open: false, query: "" };
      var tail = [hi, pop.open ? 1 : 0, pop.query || "",
        (live && live.statusText) || ""].join("\u0001");
      if (lastAn === an && lastTail === tail) {
        SPD_PORTAL = lastPortal;
        return lastOut;
      }
      var chart = spd3ChartFor(an, sd, hi, o);
      var html = spd3CardHTML(an, {
          sel: core, hover: hi, live: live, o: o,
          pop: pop,
          pool: SPD3_POOL
        }).replace("<!--CHART-->", chart);
      lastAn = an; lastTail = tail; lastOut = "\x01" + html; lastPortal = SPD_PORTAL;
      return lastOut;
    };
  }
