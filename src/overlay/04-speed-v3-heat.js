  /* ---------- v384 生成速度 Tooltip V3：热力图（本月日历 / 全部历史） ----------
   * spec §5 month/all 两行 + §2 两套颜色语义：速度色阶唯一来自 TPS_BANDS 档位类
   * （格挂档位类，CSS color-mix 淡化混底，思路移植 V2 v294 已验证的对比度结论）；
   * 模型身份色唯一来自 SPD3_PALETTE 纯哈希（格右上 ≤3 色点 + 「+N」），两套语义
   * 不混用（PRD 7.3）。网格数学移植 V2 v291 段：month=7 列周日首列（行数=
   * ceil((首日星期+天数)/7)，4~6 行，行数经 --zu-hm-rows 变量下发，v387 §11.6 行高
   * 自适应=minmax(0,1fr) 行模板 + wrap flex 链填满可用高，4/5/6 周均无底部大空白）；
   * hist=行=星期（7 行周日..周六）、列=周（列头=周起始 MM/DD，跨月首列加亮；>14 列
   * 时隔列显标签防挤、首列恒显），列宽帽 minmax(34px,64px)（v387 §11.6 去无限 1fr
   * 拉伸，短跨度不再超宽格；justify-content:flex-start=时间轴自左向右、列少时左对齐
   * 而不是居中漂浮）；周列数 >SPD3_HIST_MONTH_COLS(26) 切月粒度（v387 §11.6/PRD 7.2：
   * 每列=日历月竖条格，月 v=Σout÷Σms 加权、列头 YYYY/MM、550 日 ≤19 月列无横滚，
   * 原 spec §5「110 列硬帽」被月聚合取代）。格状态五态可区分（spec §5）：补位更暗
   * 不可交互 / 未来遮罩 / 无记录灰 / 有记录档位混底 / 今天描边；绝不伪造 0 t/s。
   * 纯字符串零 DOM：悬停日/月卡经模块外 SPD_PORTAL 侧信道（charts 纪律：构建前清空、
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
  /* hist 粒度切换阈值（spec §11.6/PRD 7.2，v387）：周列数 >26 切月粒度。原 spec §5
   * 的「110 列硬帽（超出取最近 110 列横滚）」被月聚合取代删除——26 周 ≈ 半年是日
   * 粒度周格（34px 下限）可读上限，更长跨度按月聚合后 550 日 ≤19 月列，天然无横滚，
   * 不再横滚兜底也不丢数据。 */
  var SPD3_HIST_MONTH_COLS = 26;
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
  /* 月格 aria（spec §11.6）：完整年月 + 均速档位 + 「N 天有记录 / M 次请求」；空月
   * 显式说明，绝不 0 t/s */
  function spd3MonthAria(mb) {
    var txt = SPD_L(mb.y + "年" + (mb.mo + 1) + "月", SPD3_MO_EN[mb.mo] + " " + mb.y);
    if (!(mb.v > 0)) return txt + SPD_L("，无有效速度记录", ", no rated speed data");
    var b = tpsBand(mb.v);
    return txt + SPD_L("，均速 ", ", avg ") + spd3Fmt1(mb.v) + SPD_L(" t/s", " t/s") +
      (b ? SPD_L("，" + b.zh, ", " + b.en) : "") +
      SPD_L("，" + mb.days + " 天有记录，" + mb.n + " 次请求",
        ", " + mb.days + (mb.days === 1 ? " day" : " days") + " with data, " + mb.n + " requests");
  }
  /* hover 卡时间行（spec §11.5，v387）：core 已把进行中日/月桶的 item.b 钳到 now，
   * 本层调用点对日/月格统一 Math.min(桶末, now) 下发，卡内动态取 b——b 距区间末
   * （次日/次月零点）2 分钟内 →「全天/全月」，否则显「… – 截至 HH:mm」（月卡含
   * 日期 MM-DD）。b 缺席（外部直调）按区间末=全天处理，绝不猜进行中。次日零点用
   * Date 构造器日进位（DST 安全，禁固定 864e5 步长）。 */
  function spd3HM(t) { var d = spdDate(t); return spd2(d.getHours()) + ":" + spd2(d.getMinutes()); }
  function spd3DaySpanTxt(t, b) {
    var d = spdDate(t);
    var de = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    var bb = (typeof b === "number" && b > t && b < de) ? b : de;
    var dateTxt = d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
    if (de - bb <= 120000) return dateTxt + SPD_L(" · 全天", " · All day");
    return dateTxt + SPD_L(" · 00:00 – 截至 ", " · 00:00 – until ") + spd3HM(bb);
  }
  function spd3MonthSpanTxt(mb) {
    var bb = Math.min(mb.t1, Date.now());
    var moTxt = mb.y + "/" + (mb.mo + 1);
    if (mb.t1 - bb <= 120000) return moTxt + SPD_L(" · 全月", " · Full month");
    var d = spdDate(bb);
    return moTxt + "/1 00:00 – " + SPD_L("截至 ", "until ") +
      spd2(d.getMonth() + 1) + "-" + spd2(d.getDate()) + " " + spd3HM(bb);
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
  /* 底部图例行（spec §6/§11.5）：「较低/较高」双色渐变段已随 v387 移除（PRD 6.3
   * 禁止替代档位体系，完整档位说明由图表头 ⓘ hover 承载）；保留右侧模型身份行——
   * 多模型=「颜色标记代表模型」、单模型也保留=「<模型名> · 单模型」。 */
  function spd3LegendHTML(an) {
    var right = (an.perModel && an.perModel.length === 1)
      ? spdEsc(an.perModel[0].name) + SPD_L(" · 单模型", " · single model")
      : SPD_L("颜色标记代表模型", "colors mark models");
    return '<div class="zu3-lg"><span class="zu3-lg-r">' + right + "</span></div>";
  }
  /* 内联样式：全部规则挂 .zu-sv3-root（V3 卡根，view 分片）或 .zu-sv-portal（body
   * 级悬停 Portal 容器）作用域，不与 V2 遗留 .zu-hm-* 全局规则互染；档位混底/
   * 今天描边/焦点描边/ultra 文字修正思路移植 V2 v294/v297 审查结论。静态串无用户
   * 数据，不需转义。 */
  function spd3HeatStyle() {
    return "<style>" +
      /* ---------- month（.zu3-hm）：7 列周日首列 × --zu-hm-rows 行 ----------
       * v387 §11.6 行高自适应：wrap 补 display:flex 列链（否则 wrap 塌缩内容高、
       * grid 的 flex:1 失效），grid 行模板 minmax(0,1fr) 均分可用高——4/5/6 周均
       * 填满容器、无底部大空白；补位格/未来格同属网格轨道同步拉伸。格内容顶对齐、
       * 速度值在日号下方剩余空间垂直居中（margin:auto 0），行高变化时布局不散。 */
      ".zu-sv3-root .zu3-hm{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}" +
      ".zu-sv3-root .zu3-hm .zu-sc-wrap{flex:1;min-height:0;display:flex;flex-direction:column}" +
      ".zu-sv3-root .zu3-hm-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin-bottom:4px;" +
        "text-align:center;font-size:9px;line-height:12px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-hm-grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));" +
        "grid-template-rows:repeat(var(--zu-hm-rows,5),minmax(0,1fr));gap:6px}" +
      ".zu-sv3-root .zu3-hm-grid .zu3-v{margin:auto 0}" +
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
      /* ---------- hist（.zu3-hh）：行=星期 7 行、列=周（column-major），横滚 ----------
       * v387 §11.6 列宽帽：minmax(34px,64px) 取代无限 1fr——短跨度（≤26 周）列数少
       * 时不再把少数周列拉成超宽格；justify-content:flex-start（列少左对齐：时间轴
       * 自左向右、最新周贴右端数据侧，比 center 稳——居中会让时间轴随列数漂浮）；
       * max-width:100% 防溢出。>26 周切 .zu3-hh-mo 月粒度：每列=日历月竖条格
       * （grid-row:1/8 跨满 7 行，星期行首标签列在月分支不渲染），列宽下限放宽到
       * 18px（19 月列 ×64px 上限仍会超容器，18px 下限 + flex-start 左对齐下 19 列
       * ≈ (容器-缝隙)/19 ≈ 29px 铺满无横滚），min-width 同步放宽（21=18+gap3）。 */
      ".zu-sv3-root .zu3-hh{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}" +
      ".zu-sv3-root .zu3-hh-body{flex:1;min-height:0;display:flex;gap:6px;min-width:0}" +
      ".zu-sv3-root .zu3-hh-wds{flex:0 0 auto;display:grid;grid-template-rows:repeat(7,1fr);gap:3px;padding-top:20px;" +
        "font-size:9px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-hh-wds span{display:flex;align-items:center;white-space:nowrap}" +
      ".zu-sv3-root .zu3-hh-scroll{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}" +
      ".zu-sv3-root .zu3-hh-cols,.zu-sv3-root .zu3-hh-grid{width:100%;max-width:100%;min-width:calc(var(--zu3-cols,1)*37px)}" +
      ".zu-sv3-root .zu3-hh-cols{display:grid;grid-template-columns:repeat(var(--zu3-cols,1),minmax(34px,64px));" +
        "gap:3px;height:14px;margin-bottom:3px}" +
      ".zu-sv3-root .zu3-cl{grid-row:1;text-align:center;font-size:8px;line-height:14px;white-space:nowrap;" +
        "font-variant-numeric:tabular-nums;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-cl.zu3-cl-mo{color:var(--color-tooltip-foreground,#fff);font-weight:600}" +
      ".zu-sv3-root .zu3-hh-grid{flex:1;min-height:0;display:grid;grid-auto-flow:column;" +
        "grid-template-rows:repeat(7,minmax(0,1fr));grid-auto-columns:minmax(34px,64px);gap:3px;" +
        "justify-content:flex-start}" +
      ".zu-sv3-root .zu3-hh-mo .zu3-hh-cols,.zu-sv3-root .zu3-hh-mo .zu3-hh-grid{min-width:calc(var(--zu3-cols,1)*21px)}" +
      ".zu-sv3-root .zu3-hh-mo .zu3-hh-cols{grid-template-columns:repeat(var(--zu3-cols,1),minmax(18px,64px))}" +
      ".zu-sv3-root .zu3-hh-mo .zu3-hh-grid{grid-auto-columns:minmax(18px,64px)}" +
      ".zu-sv3-root .zu3-hh-mo .zu3-hh-grid .zu-hm-cell{grid-row:1/8;justify-content:flex-start}" +
      ".zu-sv3-root .zu3-hh-mo .zu3-hh-grid .zu3-v{margin:auto 0}" +
      ".zu-sv3-root .zu3-hh-grid .zu-hm-cell{border-radius:4px;padding:2px 3px;justify-content:flex-end;gap:1px}" +
      /* v384 S6-MAJOR1：V2 的 .zu-hm-hist .zu-sc-wrap flex 列链未随 V3 类名迁移——
       * wrap 塌缩到内容高，grid 的 minmax(0,1fr) 行随之压扁（S6 实测 gridH 122 vs 307） */
      ".zu-sv3-root .zu3-hh .zu-sc-wrap{flex:1;min-height:0;width:100%;display:flex;flex-direction:column}" +
      /* v384 S6-MAJOR2：hist 空日格补底色（否则周五/周六整行视觉消失） */
      ".zu-sv3-root .zu3-hh-grid .zu-hm-cell.zu-hm-void{background:rgba(255,255,255,.04)}" +
      ".zu-light .zu-sv3-root .zu3-hh-grid .zu-hm-cell.zu-hm-void{background:rgba(0,0,0,.045)}" +
      /* v384 S6-MINOR3：V3 图表横滚条隐藏（06 旧规则只匹配 .zu-sv-chart） */
      ".zu-sv3-root .zu3-hh .zu-sc-wrap::-webkit-scrollbar,.zu-sv3-root .zu3-hm .zu-sc-wrap::-webkit-scrollbar{display:none}" +
      /* ---------- 共用：模型色点 / 图例 / 空态 ---------- */
      ".zu-sv3-root .zu3-mdots,.zu-sv-portal .zu3-mdots{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto}" +
      ".zu-sv3-root .zu3-mdot,.zu-sv-portal .zu3-mdot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:0 0 auto}" +
      ".zu-sv3-root .zu3-mmore,.zu-sv-portal .zu3-mmore{font-size:7px;line-height:1;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* v387 §11.5：左「较低/较高」渐变段删除后仅剩右侧模型身份行，靠右对齐 */
      ".zu-sv3-root .zu3-lg{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;" +
        "margin-top:6px;font-size:9px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
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
    /* 悬停日卡经 SPD_PORTAL 侧信道（空日/未来日/越界序号不出卡=保持空串）；
     * b=min(次日零点, now)：今天=进行中（卡显「截至 HH:mm」），已结束日=全天 */
    if (hoverIdx >= 0 && hoverIdx < nDays && grid[hoverIdx] && grid[hoverIdx].agg)
      SPD_PORTAL = spd3DayCardHTML({ t: grid[hoverIdx].t0, b: Math.min(grid[hoverIdx].t1, Date.now()),
        agg: grid[hoverIdx].agg, tn: meta.tnByDay[grid[hoverIdx].t0] || null, di: hoverIdx }, o);
    var body = "";
    for (var r2 = 0; r2 < rows; r2++)
      body += '<div role="row" style="display:contents">' + flat.slice(r2 * 7, r2 * 7 + 7).join("") + "</div>";
    return '<div class="zu-speed-chart zu-sv-chart zu3-hm">' + spd3HeatStyle() +
      spd3ChartHeadHTML(an, SPD_L("按日聚合", "aggregated by day")) +
      '<div class="zu-sc-wrap"><div class="zu3-hm-week">' + spd3WeekRow() + "</div>" +
      '<div class="zu3-hm-grid" role="grid" style="--zu-hm-rows:' + rows + '">' + body + "</div></div>" +
      spd3LegendHTML(an) + "</div>";
  }
  /* 全部历史热力（spec §5 all 行 + §11.6 v387 月聚合）：行=星期（周日..周六，与列首
   * 周日对齐，同 V2 hist）、列=周（列头=周起始 MM/DD；跨月首列加亮——MM/DD 自带月
   * 份；>14 列时隔列显标签防挤，首列恒显）；周列数 >SPD3_HIST_MONTH_COLS(26) 切月
   * 粒度（每列=日历月竖条格、列头 YYYY/MM、副题「按月聚合」，取代原 spec §5 的
   * 110 列硬帽——月聚合后 550 日 ≤19 列天然无横滚，不再取最近 N 列丢数据）。
   * 数据源=an.items 日桶（core 已合并 speed_days+晚于覆盖末日的轮表行，无重叠无遗
   * 漏）；sd 仅用于截断披露（spec §1.2，N=days 长度，core 的 an.notice 同源提示由
   * 通知行承载）。窗口=首数据日 → 今天（今天无数据=灰格照画；长空档如实显示空日，
   * 空=无数据）；日粒度 cell 列宽 min ~34px、帽 64px，超出容器宽经 .zu-sc-wrap 横
   * 滚（data-sv-end 供宿主首开滚到最新），列数经 --zu3-cols 下发。column-major 填
   * 格（一列=一周/月，V2 v292 复验教训），role=grid/row/gridcell，data-i=本视图序
   * （日粒度=日序、月粒度=月序，平铺顺序，补位不占号）。 */
  function spd3HistHTML(an, sd, hoverIdx, o) {
    SPD_PORTAL = "";
    if (!an || !Array.isArray(an.items)) return "";
    var todayStart = spdBucket(Date.now(), "day");
    var byDay = {}, first = Infinity;
    for (var i = 0; i < an.items.length; i++) {
      var it = an.items[i];
      if (!it.empty && it.a) { byDay[it.a] = it; if (it.a < first) first = it.a; }
    }
    var truncTxt = (sd && sd.truncated && sd.days && typeof sd.days.length === "number")
      ? SPD_L(" · 已截断 · 仅显示最近 " + sd.days.length + " 天",
        " · truncated · last " + sd.days.length + " days only") : "";
    if (first === Infinity)
      return '<div class="zu-speed-chart zu-sv-chart zu3-hh">' + spd3HeatStyle() +
        spd3ChartHeadHTML(an, SPD_L("按日聚合", "aggregated by day") + truncTxt) + '<div class="zu3-empty">' +
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
    /* ---- 月粒度分支（spec §11.6/PRD 7.2，v387）：周列数 >26 切日历月聚合 ----
     * 每列=月竖条格（grid-row:1/8 跨满 7 行，column-major 行结构保留、星期行首标签
     * 列不渲染——月粒度无星期语义）；月 v=Σout÷Σms 加权（spd3MonthBuckets，绝不
     * 算术平均）、days=有记录天数、n=Σ请求；列范围=首数据月 → 当前月连续铺列，
     * 无数据月=灰条如实显示（空=无数据）。列头=YYYY/MM（首列与跨年 1 月列带年并
     * 加亮 zu3-cl-mo）；550 日 ≤19 月列、session/project 更长历史按月铺列也无横滚
     * （18px 下限竖条格，见 spd3HeatStyle .zu3-hh-mo 段）。roving tabindex/空月
     * aria 纪律同日粒度。 */
    if (cols > SPD3_HIST_MONTH_COLS) {
      var months = spd3MonthBuckets(an.items, meta.capByDay);
      var byMk = {};
      for (var mi2 = 0; mi2 < months.length; mi2++) byMk[months[mi2].y * 12 + months[mi2].mo] = months[mi2];
      var dNow2 = spdDate(Date.now());
      var firstMk = months.length ? months[0].y * 12 + months[0].mo : dNow2.getFullYear() * 12 + dNow2.getMonth();
      var lastMk = dNow2.getFullYear() * 12 + dNow2.getMonth();
      var moCols = Math.max(1, lastMk - firstMk + 1);
      var moFlat = [], moLabels = "", tabMo = false;
      for (var w2 = 0; w2 < moCols; w2++) {
        var mk2 = firstMk + w2, my = Math.floor(mk2 / 12), mmo = mk2 - my * 12;
        var withYear = w2 === 0 || mmo === 0;   /* 首列与跨年 1 月列带年并加亮 */
        moLabels += '<span class="zu3-cl' + (withYear ? " zu3-cl-mo" : "") + '" style="grid-column:' + (w2 + 1) + '">' +
          (withYear ? my + "/" : "") + spd2(mmo + 1) + "</span>";
        var mb3 = byMk[mk2] || null, hasMo = !!(mb3 && mb3.v > 0);
        var clsMo = "zu-hm-cell " + (hasMo ? "zu-hm-data" : "zu-hm-void");
        if (hasMo) { var bmo = tpsBand(mb3.v); if (bmo) clsMo += " " + bmo.cls; }
        var di2 = moFlat.length;
        var headMo = '<span class="zu3-hd">' + spd3DotsHTML(mb3, single) + "</span>";
        if (hasMo) {
          moFlat.push('<div class="' + clsMo + '" role="gridcell" tabindex="' + (tabMo ? "-1" : "0") + '" data-i="' + di2 +
            '" aria-label="' + spdEsc(spd3MonthAria(mb3)) + '">' + headMo +
            '<span class="zu3-v">' + spdEsc(spd3Fmt1(mb3.v)) + "</span></div>");
          tabMo = true;
        } else {
          moFlat.push('<div class="' + clsMo + '" role="gridcell" data-i="' + di2 +
            '" aria-label="' + spdEsc(spd3MonthAria(mb3 || { y: my, mo: mmo, v: null })) + '">' + headMo + "</div>");
        }
      }
      if (hoverIdx >= 0 && hoverIdx < moCols) {
        var mb4 = byMk[firstMk + hoverIdx];
        if (mb4 && mb4.v > 0) SPD_PORTAL = spd3MonthCardHTML(mb4);
      }
      var moRows = "";
      for (var r4 = 0; r4 < moFlat.length; r4++)
        moRows += '<div role="row" style="display:contents">' + moFlat[r4] + "</div>";
      return '<div class="zu-speed-chart zu-sv-chart zu3-hh zu3-hh-mo">' + spd3HeatStyle() +
        spd3ChartHeadHTML(an, SPD_L("按月聚合", "aggregated by month") + truncTxt) +
        '<div class="zu3-hh-body">' +
        '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu3-hh-scroll">' +
        '<div class="zu3-hh-cols" style="--zu3-cols:' + moCols + '">' + moLabels + "</div>" +
        '<div class="zu3-hh-grid" role="grid" style="--zu3-cols:' + moCols + '">' + moRows + "</div>" +
        "</div></div></div>" + spd3LegendHTML(an) + "</div>";
    }
    var sub = SPD_L("按日聚合", "aggregated by day") + truncTxt;
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
        /* end=次日零点（Date 构造器日进位，DST 安全）：悬停日卡时间行据此区分
         * 「全天 / 截至 HH:mm」（今天桶 b 由调用点钳到 now，spec §11.5） */
        days.push({ t: ds, end: new Date(fy, fmo, fd - lead + w * 7 + r + 1).getTime(),
          agg: it2, capped: !!meta.capByDay[ds] });
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
      SPD_PORTAL = spd3DayCardHTML({ t: days[hoverIdx].t, b: Math.min(days[hoverIdx].end, Date.now()),
        agg: days[hoverIdx].agg, capped: days[hoverIdx].capped,
        tn: meta.tnByDay[days[hoverIdx].t] || null, di: hoverIdx }, o);
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
  /* 日悬停卡（SPD_PORTAL 内容生产者，纯字符串）：item={t 日零点, b? 进行中当前时刻
   * （调用点已钳 Math.min(桶末, now)；缺席=全天）, agg spd3Aggregate 结果,
   * tn? {key:当日轮数}, capped? 生产端模型列表截断, di? 悬停序号}。
   * 标题「M/D（周X） · 模型明细」（多模型）/「M/D（周X）」；区间行=「YYYY/M/D ·
   * 全天」或「YYYY/M/D · 00:00 – 截至 HH:mm」（spd3DaySpanTxt，spec §11.5）；
   * 行1 日均速度（档位色）；随后每模型行=色点+名+N轮+均速（模型分量无窗口 →
   * tps=null 只显轮次，绝不冒充速度，spec §6 降级模式）；tn 缺席时回退 n（单模型
   * 轮 n≈轮数）。capped 日尾注：生产端 msl ≤12 截断后真实总数不可知，定性披露不
   * 编数字。空 item/无有效速度 → 空串不出卡。动态内容（模型名）一律 spdEsc 转义。 */
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
      '<div class="zu-sv3-crow"><span>' + spdEsc(spd3DaySpanTxt(item.t, item.b)) + "</span></div>" +
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
  /* 日桶→月桶（spec §11.6/PRD 7.2，v387 月聚合，唯一消费者 spd3HistHTML >26 周分
   * 支）：items 日桶按日历月重排（mk=年*12+月，列序自然升序）。月 v=Σout÷Σms 加权
   * （口径 §0：绝不按日算术平均）、n=Σ请求、days=有记录天数；models 按 key 累计
   * {o,ms,n} 供月卡构成——日桶 models 全空（降级帧筛选清空分量）→ ml 空，月卡如
   * 实省略构成段，绝不伪造；capped=当月存在 capFlag 日（生产端 msl 截断 → 月卡定
   * 性尾注，不编数字）。 */
  function spd3MonthBuckets(items, capByDay) {
    var byM = {}, keys = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.empty || !it.a) continue;
      var d = spdDate(it.a), mk = d.getFullYear() * 12 + d.getMonth();
      var mb = byM[mk];
      if (!mb) {
        mb = byM[mk] = { y: d.getFullYear(), mo: d.getMonth(), out: 0, ms: 0, n: 0, days: 0, models: {}, capped: false };
        keys.push(mk);
      }
      mb.out += it.out; mb.ms += it.ms; mb.n += spdNum(it.n); mb.days++;
      if (capByDay && capByDay[it.a]) mb.capped = true;
      var mm = it.models || [];
      for (var j = 0; j < mm.length; j++) {
        var m = mm[j], e = mb.models[m.key];
        if (!e) e = mb.models[m.key] = { key: m.key, name: m.name, pid: m.pid || "", mid: m.mid || "", o: 0, ms: 0, n: 0 };
        e.o += m.o; e.ms += spdNum(m.ms); e.n += spdNum(m.n);
      }
    }
    keys.sort(function (a, b) { return a - b; });
    var months = [];
    for (var k = 0; k < keys.length; k++) {
      var b2 = byM[keys[k]], ml = [];
      for (var key in b2.models) if (b2.models[key].o > 0) ml.push(b2.models[key]);
      ml.sort(function (a, b) { return b.o - a.o; });
      months.push({ y: b2.y, mo: b2.mo, t0: new Date(b2.y, b2.mo, 1).getTime(),
        t1: new Date(b2.y, b2.mo + 1, 1).getTime(),
        v: b2.ms > 0 ? b2.out / (b2.ms / 1000) : null,
        out: b2.out, ms: b2.ms, n: b2.n, days: b2.days, models: ml, capped: b2.capped });
    }
    return months;
  }
  /* 月悬停卡（SPD_PORTAL 内容生产者，纯字符串，spec §11.6）：标题「YYYY年M月 ·
   * 月度统计」；区间行（进行月=「YYYY/M/1 00:00 – 截至 MM-DD HH:mm」，已结束月=
   * 「YYYY/M · 全月」，规则同 §11.5 日卡、动态取钳后 b）；月均速度（档位色）；
   * 「N 天有记录 / M 次请求」；模型构成=各模型 Σout 占比前 3 +「另有 N 个模型」，
   * 月桶无每模型分量（降级帧）时整段如实省略；capped 定性尾注。空月/无有效速度 →
   * 空串不出卡。动态内容（模型名）一律 spdEsc 转义。 */
  function spd3MonthCardHTML(mb) {
    if (!mb || !(mb.v > 0)) return "";
    var bd = tpsBand(mb.v);
    var s = '<div class="zu-sv-card zu-sv3-card" role="tooltip">' +
      '<div class="zu-sv3-crow zu-sv3-chead"><b>' +
      spdEsc(SPD_L(mb.y + "年" + (mb.mo + 1) + "月 · 月度统计",
        SPD3_MO_EN[mb.mo] + " " + mb.y + " · Monthly stats")) + "</b></div>" +
      '<div class="zu-sv3-crow"><span>' + spdEsc(spd3MonthSpanTxt(mb)) + "</span></div>" +
      '<div class="zu-sv3-crow"><span>' + SPD_L("月均速度", "Month avg") + '</span><b class="zu-sv3-cval' +
      (bd ? " " + bd.cls : "") + '">' + spdEsc(spd3Fmt1(mb.v)) + SPD_L(" t/s", " t/s") + "</b></div>" +
      '<div class="zu-sv3-crow"><span>' + mb.days + SPD_L(" 天有记录 / ", " days with data / ") +
      mb.n + SPD_L(" 次请求", " requests") + "</span></div>";
    var ml = mb.models || [], shown = Math.min(3, ml.length);
    for (var i = 0; i < shown; i++) {
      var m = ml[i], pct = mb.out > 0 ? Math.round(m.o * 100 / mb.out) : 0;
      s += '<div class="zu-sv3-crow zu-sv3-mrow"><span class="zu3-mdot" style="background:' +
        spd3Color(m.key) + '"></span><b class="zu-sv3-mname" title="' + spdEsc(m.name || "") + '">' +
        spdEsc(m.name || SPD_L("未知模型", "Unknown model")) + "</b>" +
        '<b class="zu-sv3-mtps">' + pct + "%</b></div>";
    }
    if (ml.length > 3)
      s += '<div class="zu-sv3-crow zu-sv3-capped">' +
        SPD_L("另有 " + (ml.length - 3) + " 个模型", (ml.length - 3) + " more models") + "</div>";
    if (mb.capped)
      s += '<div class="zu-sv3-crow zu-sv3-capped">' + SPD_L("另有更多模型未列入", "more models not listed") + "</div>";
    return s + "</div>";
  }
  /* SPD_V3_HEAT_END */
