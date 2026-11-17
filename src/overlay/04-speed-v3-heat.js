  /* ---------- v384 生成速度 Tooltip V3：热力图（本月日历 / 全部历史） ----------
   * spec §5 month/all 两行 + §2 两套颜色语义：速度色阶唯一来自 TPS_BANDS 档位类
   * （格挂档位类，CSS color-mix 淡化混底，思路移植 V2 v294 已验证的对比度结论）；
   * 模型身份色唯一来自 SPD3_PALETTE 纯哈希（格右上 ≤3 色点 + 「+N」），两套语义
   * 不混用（PRD 7.3）。网格数学移植 V2 v291 段：month=7 列周日首列（行数=
   * ceil((首日星期+天数)/7)，4~6 行，行数经 --zu-hm-rows 变量下发）；hist=行=星期
   * （7 行周日..周六）、列=周（列头=周起始 MM/DD，跨月首列加亮；>14 列时隔列显
   * 标签防挤、首列恒显），cell 最小 ~34px、超出容器宽经 .zu-sc-wrap 横滚。
   * 格状态五态可区分（spec §5）：补位更暗不可交互 / 未来遮罩 / 无记录灰 / 有记录
   * 档位混底 / 今天描边；绝不伪造 0 t/s。
   * 纯字符串零 DOM：悬停日卡经模块外 SPD_PORTAL 侧信道（charts 纪律：构建前清空、
   * 有悬停整体覆写 <div class="zu-sv-card …" data-i="N">、未悬停/无数据日=空串，
   * 消费即清，跨帧/跨 tip 不串）。
   * 引用边界：存活符号 L/SPD_L/TPS_BANDS/tpsBand/spdEsc/spdNum/spd2/spdDate/
   * spdBucket + core 分片全部 spd3* 导出（spd3Color/spd3ModelKey）+ view 分片的
   * spd3ChartHeadHTML（并行开发中）。V2 专属函数（spdMonthHeatmapHTML/
   * spdHistoryHeatmapHTML/spdDayCardHTML 等）随 V3 上线删除，一律不引用；其余依赖
   * 一律本地 spd3 版本，保证本文件可独立 node --check、可单独切片进 VM 夹具。 */
  /* SPD_V3_HEAT_BEGIN */
  var SPD3_WD_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var SPD3_WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var SPD3_MO_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function spd3Wd(wd) { return SPD_L(SPD3_WD_ZH[wd], SPD3_WD_EN[wd]); }
  /* 一位小数速度文本（整数不带小数点，纪律同 V2 spdFmt1） */
  function spd3Fmt1(v) { return v % 1 ? v.toFixed(1) : String(v); }
  /* 图例两端色（纯静态展示值，无用户数据不需转义）：低=TPS_BANDS 末档 hot 实色、
   * 高=首档 ultra 渐变，与 06 分片档位调色板同值；档位选取走表序（tpsBand(0)=最低
   * 档、TPS_BANDS[0]=最高档），表序变化自动跟随，未知类名回退 currentColor。 */
  var SPD3_LEG_BG = { hot: "#ff6b57", "zu-ultra": "linear-gradient(100deg,#60a5fa 0%,#a78bfa 50%,#c084fc 100%)" };
  /* 格 aria（spec §7）：完整日期 + 均速档位 + 模型数；无记录日显式说明，绝不 0 t/s */
  function spd3CellAria(t, agg) {
    var d = spdDate(t), wd = d.getDay();
    var dateTxt = SPD_L(d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + SPD3_WD_ZH[wd],
      SPD3_WD_EN[wd] + ", " + SPD3_MO_EN[d.getMonth()] + " " + d.getDate() + " " + d.getFullYear());
    if (!agg) return dateTxt + SPD_L("，无有效速度记录", ", no rated speed data");
    var b = tpsBand(agg.v);
    return dateTxt + SPD_L("，均速 ", ", avg ") + spd3Fmt1(agg.v) + SPD_L(" t/s", " t/s") +
      (b ? SPD_L("，" + b.zh, ", " + b.en) : "") +
      SPD_L("，" + agg.modelCount + " 个模型", ", " + agg.modelCount + (agg.modelCount === 1 ? " model" : " models"));
  }
  /* 格右上模型色点：当日 models（spd3Aggregate 已按 out 降序、不截断）取前 3 枚 +
   * 剩余「+N」；单模型视图（an.perModel.length===1）不渲染重复色点（spec §5）。
   * 点是身份标记不是速度，与 an.msAvail 无关；色值=spd3Color(模型 key) 纯哈希。 */
  function spd3DotsHTML(agg, single) {
    if (single || !agg || !agg.models || !agg.models.length) return "";
    var n = Math.min(3, agg.models.length), s = "";
    for (var i = 0; i < n; i++)
      s += '<span class="zu3-mdot" style="background:' + spd3Color(spd3ModelKey(agg.models[i])) + '"></span>';
    if (agg.models.length > 3) s += '<span class="zu3-mmore">+' + (agg.models.length - 3) + "</span>";
    return '<span class="zu3-mdots">' + s + "</span>";
  }
  /* 池内逐日元数据（单趟扫描，month/hist 共用）：tnByDay[日零点][模型key]=当日
   * distinct 轮数（speed_days 日行用 msl tn，轮表行每含该模型一轮计 1，同
   * spd3PerModel 口径）；capByDay=生产端 capFlag（日行模型列表截断）。供日悬停卡
   * 的「N 轮」与截断注记。日行键=契约 t0（与 an.items 桶键同源）；轮表行键=
   * spdBucket 本地零点（跨 DST 时与固定步长 t0 有 ±1h 级偏差，属 core ② 既定口径）。 */
  function spd3DayMeta(pool) {
    var tnByDay = {}, capByDay = {};
    for (var i = 0; i < (pool || []).length; i++) {
      var r = pool[i];
      if (!r || !r.models) continue;
      var dk = (r.t0 !== undefined) ? r.t0 : spdBucket(r.t, "day");
      if (r.capped) capByDay[dk] = true;
      var dtn = tnByDay[dk];
      if (!dtn) dtn = tnByDay[dk] = {};
      for (var j = 0; j < r.models.length; j++) {
        var k = spd3ModelKey(r.models[j]), tn = r.models[j].tn;
        dtn[k] = (dtn[k] || 0) + ((typeof tn === "number" && isFinite(tn) && tn > 0) ? tn : 1);
      }
    }
    return { tnByDay: tnByDay, capByDay: capByDay };
  }
  /* 周日..周六表头（month 列头 / hist 行首共用） */
  function spd3WeekRow() {
    var s = "";
    for (var i = 0; i < 7; i++) s += "<span>" + spdEsc(spd3Wd(i)) + "</span>";
    return s;
  }
  /* 底部图例行（spec §6）：左 较低→较高（TPS_BANDS 首末档色两枚小色块，纯静态）；
   * 右 多模型=「颜色标记代表模型」、单模型=「<模型名> · 单模型」 */
  function spd3LegendHTML(an) {
    var loBg = SPD3_LEG_BG[tpsBand(0).cls] || "currentColor";
    var hiBg = SPD3_LEG_BG[TPS_BANDS[0].cls] || "currentColor";
    var right = (an.perModel && an.perModel.length === 1)
      ? spdEsc(an.perModel[0].name) + SPD_L(" · 单模型", " · single model")
      : SPD_L("颜色标记代表模型", "colors mark models");
    return '<div class="zu3-lg"><span class="zu3-lg-l"><i>' + SPD_L("较低", "Lower") + "</i>" +
      '<span class="zu3-lg-sw" style="background:' + loBg + '"></span>' +
      '<span class="zu3-lg-sw" style="background:' + hiBg + '"></span>' +
      "<i>" + SPD_L("较高", "Higher") + '</i></span><span class="zu3-lg-r">' + right + "</span></div>";
  }
  /* 内联样式：全部规则挂 .zu-sv3-root（V3 卡根，view 分片）或 .zu-sv-portal（body
   * 级悬停 Portal 容器）作用域，不与 V2 遗留 .zu-hm-* 全局规则互染；档位混底/
   * 今天描边/焦点描边/ultra 文字修正思路移植 V2 v294/v297 审查结论。静态串无用户
   * 数据，不需转义。 */
  function spd3HeatStyle() {
    return "<style>" +
      /* ---------- month（.zu3-hm）：7 列周日首列 × --zu-hm-rows 行 ---------- */
      ".zu-sv3-root .zu3-hm{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}" +
      ".zu-sv3-root .zu3-hm-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin-bottom:4px;" +
        "text-align:center;font-size:9px;line-height:12px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-hm-grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));" +
        "grid-template-rows:repeat(var(--zu-hm-rows,5),minmax(0,1fr));gap:6px}" +
      ".zu-sv3-root .zu-hm-pad{display:block;min-height:1px}" +
      ".zu-sv3-root .zu-hm-cell{position:relative;display:flex;flex-direction:column;justify-content:space-between;" +
        "min-width:0;min-height:0;box-sizing:border-box;border-radius:7px;padding:3px 4px;" +
        "background:rgba(255,255,255,.045);-webkit-text-fill-color:initial}" +
      ".zu-light .zu-sv3-root .zu-hm-cell{background:rgba(0,0,0,.04)}" +
      ".zu-sv3-root .zu-hm-cell::before{content:none}" +
      ".zu-sv3-root .zu-hm-cell.zu-hm-void{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-hm-cell.zu-hm-fut{color:var(--color-tooltip-tag-foreground,#a6a6a6);opacity:.7;background:rgba(255,255,255,.02)}" +
      ".zu-light .zu-sv3-root .zu-hm-cell.zu-hm-fut{background:rgba(0,0,0,.02)}" +
      /* 有记录日：档位色 22% 混卡片底（V2 v294 对比度结论沿用）；今天=1.5px 内描边 */
      ".zu-sv3-root .zu-hm-cell.zu-hm-data{background:color-mix(in srgb,currentColor 22%,var(--color-popover,#1c212b))}" +
      ".zu-sv3-root .zu-hm-cell.zu-hm-today{box-shadow:inset 0 0 0 1.5px var(--color-popover-border,rgba(255,255,255,.4))}" +
      ".zu-sv3-root .zu-hm-cell:hover{filter:brightness(1.07)}" +
      ".zu-sv3-root .zu-hm-cell:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv3-root .zu3-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:2px;min-height:0}" +
      ".zu-sv3-root .zu3-d{flex:0 0 auto;font-size:8px;line-height:1;font-weight:500;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-v{flex:0 0 auto;font-size:9px;line-height:1.1;font-weight:600;font-variant-numeric:tabular-nums;" +
        "color:var(--color-tooltip-foreground,#fff);white-space:nowrap;overflow:hidden}" +
      /* ---------- hist（.zu3-hh）：行=星期 7 行、列=周（column-major），横滚 ---------- */
      ".zu-sv3-root .zu3-hh{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}" +
      ".zu-sv3-root .zu3-hh-body{flex:1;min-height:0;display:flex;gap:6px;min-width:0}" +
      ".zu-sv3-root .zu3-hh-wds{flex:0 0 auto;display:grid;grid-template-rows:repeat(7,1fr);gap:3px;padding-top:20px;" +
        "font-size:9px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-hh-wds span{display:flex;align-items:center;white-space:nowrap}" +
      ".zu-sv3-root .zu3-hh-scroll{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}" +
      ".zu-sv3-root .zu3-hh-cols,.zu-sv3-root .zu3-hh-grid{width:100%;min-width:calc(var(--zu3-cols,1)*37px)}" +
      ".zu-sv3-root .zu3-hh-cols{display:grid;grid-template-columns:repeat(var(--zu3-cols,1),minmax(34px,1fr));" +
        "gap:3px;height:14px;margin-bottom:3px}" +
      ".zu-sv3-root .zu3-cl{grid-row:1;text-align:center;font-size:8px;line-height:14px;white-space:nowrap;" +
        "font-variant-numeric:tabular-nums;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-cl.zu3-cl-mo{color:var(--color-tooltip-foreground,#fff);font-weight:600}" +
      ".zu-sv3-root .zu3-hh-grid{flex:1;min-height:0;display:grid;grid-auto-flow:column;" +
        "grid-template-rows:repeat(7,minmax(0,1fr));grid-auto-columns:minmax(34px,1fr);gap:3px}" +
      ".zu-sv3-root .zu3-hh-grid .zu-hm-cell{border-radius:4px;padding:2px 3px;justify-content:flex-end;gap:1px}" +
      /* ---------- 共用：模型色点 / 图例 / 空态 ---------- */
      ".zu-sv3-root .zu3-mdots,.zu-sv-portal .zu3-mdots{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto}" +
      ".zu-sv3-root .zu3-mdot,.zu-sv-portal .zu3-mdot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:0 0 auto}" +
      ".zu-sv3-root .zu3-mmore,.zu-sv-portal .zu3-mmore{font-size:7px;line-height:1;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-lg{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;" +
        "margin-top:6px;font-size:9px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-lg-l{display:inline-flex;align-items:center;gap:4px}" +
      ".zu-sv3-root .zu3-lg-l i{font-style:normal}" +
      ".zu-sv3-root .zu3-lg-sw{width:14px;height:6px;border-radius:3px;display:inline-block}" +
      ".zu-sv3-root .zu3-empty{flex:1;display:flex;align-items:center;justify-content:center;" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:11px}" +
      /* ---------- 日悬停卡（body 级 Portal 内，.zu-sv3-card 全自持样式） ---------- */
      ".zu-sv-portal .zu-sv3-card{box-sizing:border-box;min-width:180px;max-width:260px;padding:8px 10px;border-radius:10px;" +
        "background:var(--color-popover,#1c212b);border:1px solid var(--color-popover-border,rgba(255,255,255,.14));" +
        "box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:10px;line-height:1.5;color:var(--color-tooltip-foreground,#e9edf4)}" +
      ".zu-sv-portal .zu-sv3-crow{display:flex;align-items:baseline;gap:6px;padding:1px 0}" +
      ".zu-sv-portal .zu-sv3-crow>span{flex:0 0 auto;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv-portal .zu-sv3-chead{font-weight:600;margin-bottom:2px}" +
      ".zu-sv-portal .zu-sv3-chead b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-sv-portal .zu-sv3-mrow{gap:5px}" +
      ".zu-sv-portal .zu-sv3-mname{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}" +
      ".zu-sv-portal .zu-sv3-mtn{flex:0 0 auto;font-style:normal;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv-portal .zu-sv3-mtps{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".zu-sv-portal .zu-sv3-capped{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      "</style>";
  }
  /* 本月日历热力（spec §5 month 行）：数据源=an.daysGrid（core 已产当月全日格集，
   * agg=null=空日/未来日，铺格由本层区分）。网格=7 列周日首列 × ceil((首日星期+
   * 天数)/7) 行；补位格（邻月占位）不可交互、未来日 aria-hidden 遮罩、无记录灰、
   * 有记录挂档位类（混底走 CSS）、今天描边。格内容=日号+日均速度（一位小数），
   * 右上模型点见 spd3DotsHTML。头图 sub=聚合粒度说明；底部图例见 spd3LegendHTML。
   * role=grid/row（display:contents 保网格布局）/gridcell；data-i=daysGrid 日序，
   * 悬停重编按同序取日出卡。 */
  function spd3MonthHTML(an, hoverIdx, o) {
    SPD_PORTAL = "";
    if (!an || !an.daysGrid || !an.daysGrid.length) return "";
    var d0 = spdDate(Date.now());
    var todayStart = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
    var grid = an.daysGrid, nDays = grid.length;
    var lead = new Date(grid[0].t0).getDay();   /* 周日=0 → 首列周日对齐 */
    var rows = Math.ceil((lead + nDays) / 7);
    var single = !!(an.perModel && an.perModel.length === 1);
    var meta = spd3DayMeta(an.pool);
    var flat = [], i, tabSet3 = false;   /* v384 M1：roving tabindex——每网格首格 0 其余 -1 */
    for (i = 0; i < lead; i++) flat.push('<i class="zu-hm-pad" aria-hidden="true"></i>');
    for (i = 0; i < nDays; i++) {
      var g = grid[i], agg = g.agg || null;
      var future = g.t0 > todayStart, today = g.t0 === todayStart;
      var dn = spdDate(g.t0).getDate();
      var cls = "zu-hm-cell";
      if (future) cls += " zu-hm-fut";
      else if (agg) { cls += " zu-hm-data"; var bd = tpsBand(agg.v); if (bd) cls += " " + bd.cls; }
      else cls += " zu-hm-void";
      if (today) cls += " zu-hm-today";
      var head = '<span class="zu3-hd"><span class="zu3-d">' + dn + "</span>" + spd3DotsHTML(agg, single) + "</span>";
      if (future) {
        /* 未来日=遮罩占位：aria-hidden 不进读数、无 tabindex 不进 Tab 序（结构上仍
         * 是 gridcell 保日历完整），绝不伪造速度 */
        flat.push('<div class="' + cls + '" role="gridcell" aria-hidden="true" data-i="' + i + '">' + head + "</div>");
      } else if (agg) {
        flat.push('<div class="' + cls + '" role="gridcell" tabindex="' + (tabSet3 ? "-1" : "0") + '" data-i="' + i +
          '" aria-label="' + spdEsc(spd3CellAria(g.t0, agg)) + '">' + head +
          '<span class="zu3-v">' + spdEsc(spd3Fmt1(agg.v)) + "</span></div>");
        tabSet3 = true;
      } else {
        flat.push('<div class="' + cls + '" role="gridcell" data-i="' + i +
          '" aria-label="' + spdEsc(spd3CellAria(g.t0, null)) + '">' + head + "</div>");
      }
    }
    /* 悬停日卡经 SPD_PORTAL 侧信道（空日/未来日/越界序号不出卡=保持空串） */
    if (hoverIdx >= 0 && hoverIdx < nDays && grid[hoverIdx] && grid[hoverIdx].agg)
      SPD_PORTAL = spd3DayCardHTML({ t: grid[hoverIdx].t0, agg: grid[hoverIdx].agg,
        tn: meta.tnByDay[grid[hoverIdx].t0] || null, di: hoverIdx }, o);
    var body = "";
    for (var r2 = 0; r2 < rows; r2++)
      body += '<div role="row" style="display:contents">' + flat.slice(r2 * 7, r2 * 7 + 7).join("") + "</div>";
    return '<div class="zu-speed-chart zu-sv-chart zu3-hm">' + spd3HeatStyle() +
      spd3ChartHeadHTML(an, SPD_L("按日聚合", "aggregated by day")) +
      '<div class="zu-sc-wrap"><div class="zu3-hm-week">' + spd3WeekRow() + "</div>" +
      '<div class="zu3-hm-grid" role="grid" style="--zu-hm-rows:' + rows + '">' + body + "</div></div>" +
      spd3LegendHTML(an) + "</div>";
  }
  /* 全部历史热力（spec §5 all 行）：行=星期（周日..周六，与列首周日对齐，同 V2
   * hist）、列=周（列头=周起始 MM/DD；跨月首列加亮——MM/DD 自带月份；>14 列时隔
   * 列显标签防挤，首列恒显）。数据源=an.items 日桶（core 已合并 speed_days+晚于
   * 覆盖末日的轮表行，无重叠无遗漏）；sd 仅用于截断披露（spec §1.2，N=days 长度，
   * core 的 an.notice 同源提示由通知行承载）。窗口=首数据日 → 今天（今天无数据=灰
   * 格照画；长空档如实显示空日，空=无数据）；cell 列宽 min ~34px，超出容器宽经
   * .zu-sc-wrap 横滚（data-sv-end 供宿主首开滚到最新），列数经 --zu3-cols 下发。
   * column-major 填格（一列=一周，V2 v292 复验教训），role=grid/row/gridcell，
   * data-i=本视图日序（平铺顺序，补位不占号）。 */
  function spd3HistHTML(an, sd, hoverIdx, o) {
    SPD_PORTAL = "";
    if (!an || !Array.isArray(an.items)) return "";
    var todayStart = spdBucket(Date.now(), "day");
    var byDay = {}, first = Infinity;
    for (var i = 0; i < an.items.length; i++) {
      var it = an.items[i];
      if (!it.empty && it.a) { byDay[it.a] = it; if (it.a < first) first = it.a; }
    }
    var sub = SPD_L("按日聚合", "aggregated by day");
    if (sd && sd.truncated && sd.days && typeof sd.days.length === "number")
      sub = SPD_L("按日聚合 · 已截断 · 仅显示最近 " + sd.days.length + " 天",
        "aggregated by day · truncated · last " + sd.days.length + " days only");
    if (first === Infinity)
      return '<div class="zu-speed-chart zu-sv-chart zu3-hh">' + spd3HeatStyle() +
        spd3ChartHeadHTML(an, sub) + '<div class="zu3-empty">' +
        SPD_L("暂无有效速度记录", "no rated speed data yet") + "</div></div>";
    var fd0 = spdDate(first);
    var fy = fd0.getFullYear(), fmo = fd0.getMonth(), fd = fd0.getDate();
    var totalDays = Math.round((todayStart - first) / 864e5) + 1;
    /* 网格起点=首数据日所在周的周日（行 r=0 恒周日，与 wds 行首标签对齐，V2 v292
     * column-major 教训沿用）；首数据日周中的偏移补位由 ds<first 分支产出 */
    var lead = new Date(fy, fmo, fd).getDay();
    var cols = Math.ceil((lead + totalDays) / 7);
    var single = !!(an.perModel && an.perModel.length === 1);
    var meta = spd3DayMeta(an.pool);
    var labelEvery = cols > 14 ? 2 : 1;
    var flat = [], days = [], labels = "", lastMo = -1, tabSet3 = false;   /* v384 M1：roving tabindex */
    for (var w = 0; w < cols; w++) {
      var cs = new Date(fy, fmo, fd - lead + w * 7);   /* 列头=周起始日（周日） */
      if (w === 0 || w % labelEvery === 0)
        labels += '<span class="zu3-cl' + (cs.getMonth() !== lastMo ? " zu3-cl-mo" : "") +
          '" style="grid-column:' + (w + 1) + '">' + spd2(cs.getMonth() + 1) + "/" + spd2(cs.getDate()) + "</span>";
      if (cs.getMonth() !== lastMo) lastMo = cs.getMonth();
      for (var r = 0; r < 7; r++) {
        var ds = new Date(fy, fmo, fd - lead + w * 7 + r).getTime();   /* Date 构造器推进，DST 安全 */
        if (ds < first || ds > todayStart) { flat.push('<i class="zu-hm-pad" aria-hidden="true"></i>'); continue; }
        var it2 = byDay[ds] || null, bd2 = it2 ? tpsBand(it2.v) : null;
        var di = days.length;
        days.push({ t: ds, agg: it2, capped: !!meta.capByDay[ds] });
        var cls2 = "zu-hm-cell " + (it2 ? "zu-hm-data" + (bd2 ? " " + bd2.cls : "") : "zu-hm-void") +
          (ds === todayStart ? " zu-hm-today" : "");
        var inner = '<span class="zu3-hd">' + spd3DotsHTML(it2, single) + "</span>";
        if (it2) {
          flat.push('<div class="' + cls2 + '" role="gridcell" tabindex="' + (tabSet3 ? "-1" : "0") + '" data-i="' + di +
            '" aria-label="' + spdEsc(spd3CellAria(ds, it2)) + '">' + inner +
            '<span class="zu3-v">' + spdEsc(spd3Fmt1(it2.v)) + "</span></div>");
          tabSet3 = true;
        }
        else
          flat.push('<div class="' + cls2 + '" role="gridcell" data-i="' + di +
            '" aria-label="' + spdEsc(spd3CellAria(ds, null)) + '">' + inner + "</div>");
      }
    }
    if (hoverIdx >= 0 && days[hoverIdx] && days[hoverIdx].agg)
      SPD_PORTAL = spd3DayCardHTML({ t: days[hoverIdx].t, agg: days[hoverIdx].agg,
        capped: days[hoverIdx].capped, tn: meta.tnByDay[days[hoverIdx].t] || null, di: hoverIdx }, o);
    var rowsHtml = "", nRows = Math.ceil(flat.length / 7);
    for (var r3 = 0; r3 < nRows; r3++)
      rowsHtml += '<div role="row" style="display:contents">' + flat.slice(r3 * 7, r3 * 7 + 7).join("") + "</div>";
    return '<div class="zu-speed-chart zu-sv-chart zu3-hh">' + spd3HeatStyle() +
      spd3ChartHeadHTML(an, sub) +
      '<div class="zu3-hh-body"><div class="zu3-hh-wds">' + spd3WeekRow() + "</div>" +
      '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu3-hh-scroll">' +
      '<div class="zu3-hh-cols" style="--zu3-cols:' + cols + '">' + labels + "</div>" +
      '<div class="zu3-hh-grid" role="grid" style="--zu3-cols:' + cols + '">' + rowsHtml + "</div>" +
      "</div></div></div>" + spd3LegendHTML(an) + "</div>";
  }
  /* 日悬停卡（SPD_PORTAL 内容生产者，纯字符串）：item={t 日零点, agg spd3Aggregate
   * 结果, tn? {key:当日轮数}, capped? 生产端模型列表截断, di? 悬停序号}。
   * 标题「M/D（周X） · 模型明细」（多模型）/「M/D（周X）」；行1 日均速度（档位色）；
   * 随后每模型行=色点+名+N轮+均速（模型分量无窗口 → tps=null 只显轮次，绝不冒充
   * 速度，spec §6 降级模式）；tn 缺席时回退 n（单模型轮 n≈轮数）。capped 日尾注：
   * 生产端 msl ≤12 截断后真实总数不可知，定性披露不编数字。空 item/无有效速度 →
   * 空串不出卡。动态内容（模型名）一律 spdEsc 转义。 */
  function spd3DayCardHTML(item, o) {
    if (!item || !item.agg || !(item.agg.v > 0) || !item.t) return "";
    var agg = item.agg, d = spdDate(item.t), wd = d.getDay();
    var dayTxt = (d.getMonth() + 1) + "/" + d.getDate() + SPD_L("（", " (") + spd3Wd(wd) + SPD_L("）", ")");
    var models = agg.models || [];
    var multi = (agg.modelCount || models.length) > 1;
    var bd = tpsBand(agg.v);
    var s = '<div class="zu-sv-card zu-sv3-card" role="tooltip"' +
      (typeof item.di === "number" ? ' data-i="' + item.di + '"' : "") + ">" +
      '<div class="zu-sv3-crow zu-sv3-chead"><b>' +
      spdEsc(dayTxt + (multi ? SPD_L(" · 模型明细", " · model detail") : "")) + "</b></div>" +
      '<div class="zu-sv3-crow"><span>' + SPD_L("日均速度", "Day avg") + '</span><b class="zu-sv3-cval' +
      (bd ? " " + bd.cls : "") + '">' + spdEsc(spd3Fmt1(agg.v)) + SPD_L(" t/s", " t/s") + "</b></div>";
    for (var i = 0; i < models.length; i++) {
      var m = models[i], key = spd3ModelKey(m), mb = tpsBand(m.tps);
      var tn = item.tn ? (spdNum(item.tn[key]) || 0) : spdNum(m.n);
      s += '<div class="zu-sv3-crow zu-sv3-mrow"><span class="zu3-mdot" style="background:' +
        spd3Color(key) + '"></span><b class="zu-sv3-mname" title="' + spdEsc(m.name || "") + '">' +
        spdEsc(m.name || SPD_L("未知模型", "Unknown model")) + "</b>" +
        '<i class="zu-sv3-mtn">' + tn + SPD_L(" 轮", " turns") + "</i>" +
        (m.tps > 0 ? '<b class="zu-sv3-mtps' + (mb ? " " + mb.cls : "") + '">' +
          spdEsc(spd3Fmt1(m.tps)) + SPD_L(" t/s", " t/s") + "</b>" : "") +
        "</div>";
    }
    if (item.capped)
      s += '<div class="zu-sv3-crow zu-sv3-capped">' + SPD_L("另有更多模型未列入", "more models not listed") + "</div>";
    return s + "</div>";
  }
  /* SPD_V3_HEAT_END */
