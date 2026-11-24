  /* ---------- v384 生成速度 Tooltip V3：热力图（本月日历 / 全部历史） ----------
   * spec §5 month/all 两行 + §2 两套颜色语义：速度色阶唯一来自 TPS_BANDS 档位类
   * （格挂档位类，CSS color-mix 淡化混底，思路移植 V2 v294 已验证的对比度结论）；
   * 模型身份色唯一来自 SPD3_PALETTE 纯哈希（格右上 ≤3 色点 + 「+N」），两套语义
   * 不混用（PRD 7.3）。网格数学移植 V2 v291 段：month=7 列周日首列（行数=
   * ceil((首日星期+天数)/7)，4~6 行，行数经 --zu-hm-rows 变量下发，v387 §11.6 行高
   * 自适应=minmax(0,1fr) 行模板 + wrap flex 链填满可用高；v391 §15.3 行高帽 84px
   * +wrap 垂直居中——稀疏行不再拉成巨格）；hist=行=星期（7 行周日..周六）、列=周
   * （列头=周起始 MM/DD，跨月首列加亮；>14 列时隔列显标签防挤、首列恒显），列宽帽
   * minmax(34px,64px)（v387 §11.6 去无限 1fr 拉伸，短跨度不再超宽格；v388 §12.6
   * 列数分档对齐：≤14 列根挂 zu3-hh-c 整块水平居中、>14 列 flex-start 左对齐贴满
   * 容器）；v395 §18 V6 四档按 unfiltered axis 自然日跨度 spanDays 分派（activeDays
   * 只做密度披露不裁轴）：≤7 天紧凑日卡 .zu3-dc；8–21 天紧凑日历 .zu3-cal-dense、
   * 22–63 天完整日历 .zu3-cal（7 列 minmax(0,1fr) 满幅消除周列式短跨度两侧大空白，
   * 两档共用 spd3CalHTML 靠 dense 类区分）；>63 天周列贡献式，周列数 >26 切月粒度
   * （v387 §11.6/PRD 7.2：每列=日历月竖条格，月 v=Σout÷Σms 加权、列头 YYYY/MM、
   * 550 日 ≤19 月列无横滚，原 spec §5「110 列硬帽」被月聚合取代）。空日只留日号+
   * 低对比底，不再逐格重复「无记录」（§18.2）。格状态五态可区分（spec §5）：补位更暗
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
  /* v395 §18 V6 密度选择器阈值：按**自然日跨度 spanDays**（未筛选 axis 池时间轴，
   * 不按 activeDays 裁历史）分四档：
   *   ≤7  紧凑日期卡 .zu3-dc（单卡聚焦/水平排列，日期与速度清晰）；
   *   8–21 紧凑日历 .zu3-cal.zu3-cal-dense（7 列、弱化空日、副题披露活跃天数）；
   *   22–63 完整日历 .zu3-cal（7 列跨月、多模型颜色点、完整自然日）；
   *   >63 贡献热力 .zu3-hh（周列式，周列 >26 既有月聚合 .zu3-hh-mo）。
   * 旧 v391 的 ≤6 / 7–60 / >60 三档被本四档取代（SPD3_HIST_CAL_MAX_DAYS=63）。
   * activeDays 仅用于密度披露，绝不用于缩短时间轴（禁止项 2/3）。 */
  var SPD3_HIST_DC_MAX_DAYS = 7;
  var SPD3_HIST_DENSE_MAX_DAYS = 21;
  var SPD3_HIST_CAL_MAX_DAYS = 63;
  /* v395 §18.1 统一历史布局选择：单一决策点，产出 mode/dense/sub，供 spd3HistHTML
   * 分派；两档日历共用 spd3CalHTML，靠 dense 切换 CSS 类（不复制统计系统）。
   * input={spanDays 自然日跨度, activeDays 有数据日数}（构建方另经 axis3 携带
   * single/meta/start/end/todayStart/truncTxt，不进本函数）。 */
  function spd3SelectHistoryLayout(input) {
    var span = input.spanDays, act = input.activeDays;
    var mode, dense;
    if (span <= SPD3_HIST_DC_MAX_DAYS) { mode = "daycards"; dense = true; }
    else if (span <= SPD3_HIST_DENSE_MAX_DAYS) { mode = "cal"; dense = true; }
    else if (span <= SPD3_HIST_CAL_MAX_DAYS) { mode = "cal"; dense = false; }
    else { mode = "hh"; dense = false; }
    /* 活跃天数披露只在日历/贡献档（日卡天数少且不改副题，护既有精确断言）；
     * 只是密度信息，绝不用来裁时间轴或删无记录日（禁止项 2/3/5） */
    var sub = "";
    if (mode !== "daycards" && span > 1 && act < span)
      sub = SPD_L(" · 活跃 " + act + "/" + span + " 天", " · active " + act + "/" + span + " days");
    return { mode: mode, dense: dense, sub: sub };
  }
  /* v457（spec §25）：Token 总消耗文本——agg.tok 已知（>0 的有限数）才返回，经
   * o.fmtTok（跟随万/亿开关）格式化，回调缺席回退原值；未知返回空串，调用点据此
   * 不出 token 行、aria 不提 token（绝不估数）。compact=窄列形态（周列/月列）取
   * 紧凑写法（spd3TokCompact），日历格与日卡、aria、悬停卡一律全文。 */
  function spd3TokTxt(agg, o, compact) {
    var t = agg && agg.tok;
    if (!(typeof t === "number" && isFinite(t) && t > 0)) return "";
    var f = o && typeof o.fmtTok === "function" ? o.fmtTok : null;
    var txt = String(f ? f(t) : t);
    return compact ? spd3TokCompact(txt) : txt;
  }
  /* 窄列紧凑写法（spec §25.2）：周列/月列格内容宽仅 28–58px，放不下「1234.57万」
   * 这类 9 字符写法；整数位 ≥3 位时只保留到合计 4 位数字（1234万、123.4万、12.34万、
   * 1.23亿），只裁小数位、不改量级，精确值看悬停卡与 aria。非「数字[.小数]单位」
   * 形态原样返回。 */
  function spd3TokCompact(txt) {
    var m = /^(\d+)(?:\.(\d+))?(.*)$/.exec(txt);
    if (!m || !m[2]) return txt;
    var keep = 4 - m[1].length;
    var dec = keep > 0 ? m[2].slice(0, keep).replace(/0+$/, "") : "";
    return m[1] + (dec ? "." + dec : "") + m[3];
  }
  /* 值组 HTML（spec §25.2）：有 token 文本时速度与 token 两行成组（.zu3-vwrap，
   * 列内右对齐、在日号下方剩余空间垂直居中）；无 token 时保持裸值结构（v457 前的
   * 格结构零变化）。valCls=速度元素全类名（本月 .zu3-v / 全部日历 .zu3-v zu3-cv /
   * 日卡 .zu3-dcv），由调用点给全。 */
  function spd3ValHTML(valCls, v, tokTxt) {
    var vHtml = '<span class="' + valCls + '">' + spdEsc(spd3Fmt1(v)) + "</span>";
    if (!tokTxt) return vHtml;
    return '<span class="zu3-vwrap">' + vHtml + '<span class="zu3-tk">' + spdEsc(tokTxt) + "</span></span>";
  }
  /* 悬停卡「Token 总消耗」行（spec §25.2）：tok 已知才出行；数值 nowrap 一行，拆分
   * 「输入 a · 输出 b」作次行小字（柱状图悬停卡 .zu-sv-crow>b small 同构）。仅当行内
   * 输入+输出合计恰等于 tok（未筛选、或所选模型即全部 token）时带拆分；筛选后只显
   * 合计不拆——i/o 是整行口径，拆分会冒充所选模型的拆分。 */
  function spd3TokRowHTML(agg, o) {
    var tt = spd3TokTxt(agg, o);
    if (!tt) return "";
    var f = o && typeof o.fmtTok === "function" ? o.fmtTok : null;
    var fi = spdNum(agg.i), fo = spdNum(agg.o), sub = "";
    if (fi + fo === agg.tok)
      sub = "<small>" + spdEsc(SPD_L("输入 ", "in ") + String(f ? f(fi) : fi) +
        SPD_L(" · 输出 ", " · out ") + String(f ? f(fo) : fo)) + "</small>";
    return '<div class="zu-sv3-crow"><span>' + SPD_L("Token 总消耗", "Total tokens") +
      '</span><b class="zu-sv3-ctok">' + spdEsc(tt + SPD_L(" token", " tokens")) + sub + "</b></div>";
  }
  /* 格 aria（spec §7）：完整日期 + 均速档位 + 模型数；无记录日显式说明，绝不 0 t/s。
   * v457：tok 已知时补「消耗 X token」（fmtTok 缺席回退原值） */
  function spd3CellAria(t, agg, o) {
    var d = spdDate(t), wd = d.getDay();
    var dateTxt = SPD_L(d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + SPD3_WD_ZH[wd],
      SPD3_WD_EN[wd] + ", " + SPD3_MO_EN[d.getMonth()] + " " + d.getDate() + " " + d.getFullYear());
    if (!agg) return dateTxt + SPD_L("，无有效速度记录", ", no rated speed data");
    var b = tpsBand(agg.v), tk = spd3TokTxt(agg, o);
    return dateTxt + SPD_L("，均速 ", ", avg ") + spd3Fmt1(agg.v) + SPD_L(" t/s", " t/s") +
      (b ? SPD_L("，" + b.zh, ", " + b.en) : "") +
      SPD_L("，" + agg.modelCount + " 个模型", ", " + agg.modelCount + (agg.modelCount === 1 ? " model" : " models")) +
      (tk ? SPD_L("，消耗 " + tk + " token", ", " + tk + " tokens") : "");
  }
  /* 月格 aria（spec §11.6）：完整年月 + 均速档位 + 「N 天有记录 / M 次请求」；空月
   * 显式说明，绝不 0 t/s。v457：tok 已知时补「消耗 X token」 */
  function spd3MonthAria(mb, o) {
    var txt = SPD_L(mb.y + "年" + (mb.mo + 1) + "月", SPD3_MO_EN[mb.mo] + " " + mb.y);
    if (!(mb.v > 0)) return txt + SPD_L("，无有效速度记录", ", no rated speed data");
    var b = tpsBand(mb.v), tk = spd3TokTxt(mb, o);
    return txt + SPD_L("，均速 ", ", avg ") + spd3Fmt1(mb.v) + SPD_L(" t/s", " t/s") +
      (b ? SPD_L("，" + b.zh, ", " + b.en) : "") +
      SPD_L("，" + mb.days + " 天有记录，" + mb.n + " 次请求",
        ", " + mb.days + (mb.days === 1 ? " day" : " days") + " with data, " + mb.n + " requests") +
      (tk ? SPD_L("，消耗 " + tk + " token", ", " + tk + " tokens") : "");
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
  /* 底部图例行已随 v388 §12.6/PRD 10.5 整行删除：模型身份色点说明并入日/月悬停卡
   * 的模型构成行（色点+名），档位说明归图表头 ⓘ hover，常驻行不再有独立信息量。
   * 原底部图例构建函数（多模型身份行 / 单模型名行的常驻右行）随之删除。 */
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
      /* §15.2（v391 审查 M1）：热力内层根类 zu-sv-chart 命中 06 分片 V2 基础规则
       * （.zu-sv-chart{border+padding+radius}，无 .zu-sv-root 作用域全文档生效）——
       * V3 卡外层 [data-sv3-chart] 已有边界，内层再镶一圈=双重边框+24px 水平内距；
       * 此处只中和盒壳（border/padding/radius），flex 列链仍由 V2 规则承担 */
      ".zu-sv3-root .zu-sv-chart{border:0;padding:0;border-radius:0}" +
      ".zu-light .zu-sv3-root .zu-sv-chart{border-color:rgba(0,0,0,0)}" +
      /* §15.3（v391）：wrap 垂直居中——行高帽封顶后剩余空间上下均分（周头+网格作为
       * 整组居中，列对齐保持）；行多无剩余时等同顶排（行为不变） */
      ".zu-sv3-root .zu3-hm .zu-sc-wrap,.zu-sv3-root .zu3-cal .zu-sc-wrap{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}" +
      ".zu-sv3-root .zu3-hm-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin-bottom:4px;" +
        "text-align:center;font-size:9px;line-height:12px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* §15.3（v391）：行高帽 84px——flex:1 增长封顶 rows×84（行高 ≤84），2–3 行稀疏
       * 跨度格不再拉成巨高（巨大空白网格根因=minmax(0,1fr) 无上限吃满容器）；行多时
       * 可用高低于帽，行为与既有 flex 填满一致 */
      ".zu-sv3-root .zu3-hm-grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));" +
        "grid-template-rows:repeat(var(--zu-hm-rows,5),minmax(0,1fr));gap:6px;" +
        "max-height:calc(var(--zu-hm-rows,5)*84px)}" +
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
       * 时不再把少数周列拉成超宽格。v388 §12.6 列数分档对齐：≤14 列（短历史）根挂
       * zu3-hh-c，cols/grid 两容器同规则 justify-content:center（两容器同 width:100%
       * 同 justify → 列头与数据网格轨道逐列对齐保持；时间轴左→右语义保留在列序内，
       * 推翻 v387「列少左对齐」旧结论——宽卡下短历史左对齐留整块右侧空白）；
       * >14 列不挂类维持 flex-start（长历史铺满容器，左对齐才有横滚意义）。
       * >26 周切 .zu3-hh-mo 月粒度：每列=日历月竖条格（grid-row:1/8 跨满 7 行，
       * 星期行首标签列在月分支不渲染），列宽下限放宽到 18px（19 月列 ×64px 上限仍
       * 会超容器，18px 下限 + flex-start 左对齐下 19 列 ≈ (容器-缝隙)/19 ≈ 29px 铺满
       * 无横滚），月列 ≤14 的短月史同挂 zu3-hh-c 居中，min-width 同步放宽（21=18+gap3）。 */
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
      /* v388 §12.6 短历史居中：仅 ≤14 列时 builder 在根挂 zu3-hh-c（特异性 0,3,0 高于
       * 上行 0,2,0 的 flex-start）；cols 与 grid 同规则同步居中，列头/数据轨道逐列对齐 */
      ".zu-sv3-root .zu3-hh-c .zu3-hh-cols,.zu-sv3-root .zu3-hh-c .zu3-hh-grid{justify-content:center}" +
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
      /* ---------- v389 §13.4 hist ≤6 天紧凑日卡（.zu3-dc）：横排日期卡 ----------
       * 复用 .zu-hm-cell 基座（宿主 mouseover/focus/keydown 委托按该类+data-i 命中，
       * 零宿主改动）；卡级覆写：min 120px / flex 1 1 0 / 帽 160px，wrap 允许 7 天在
       * 窄窗折两行；justify/align-content center=居中分布（spec §13.4）。速度大字
       * .zu3-dcv 不设 color——继承卡上档位类的 currentColor，color-mix 混底（既有
       * .zu-hm-data 规则）与速度字同源一色；无记录卡走 .zu-hm-void 灰。 */
      ".zu-sv3-root .zu3-dc{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}" +
      ".zu-sv3-root .zu3-dc .zu-sc-wrap{flex:1;min-height:0;display:flex;flex-direction:column}" +
      ".zu-sv3-root .zu3-dc-grid{flex:1;min-height:0;display:flex;flex-wrap:wrap;gap:6px;" +
        "justify-content:center;align-content:center;align-items:stretch}" +
      /* §15.3（v391）：卡高帽 150px——1–2 天历史不再整卡拉高成巨卡（容器居中已就位） */
      ".zu-sv3-root .zu3-dc-grid .zu-hm-cell{flex:1 1 0;min-width:120px;max-width:160px;max-height:150px;box-sizing:border-box;" +
        "border-radius:9px;padding:8px 10px;gap:2px}" +
      ".zu-sv3-root .zu3-dchd{display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0}" +
      ".zu-sv3-root .zu3-dcd{font-size:15px;line-height:1.1;font-weight:600;font-variant-numeric:tabular-nums;" +
        "color:var(--color-tooltip-foreground,#fff)}" +
      ".zu-sv3-root .zu3-dcw{font-size:9px;line-height:1.2;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-dcv{font-size:18px;line-height:1.1;font-weight:600;font-variant-numeric:tabular-nums;" +
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      /* v395 §18.2：.zu3-dcnone「无记录」轻字退役——空日只留日期/星期+低对比底 */
      /* ---------- v391 §15.3 hist 7–60 天七列日历式（.zu3-cal）----------
       * 与 month 组件同构复用（spec §14.3：span 代替当月）：周头 .zu3-hm-week、网格
       * .zu3-hm-grid、格基座 .zu-hm-cell* 与档位混底/今天描边/模型点各规则全挂
       * .zu-sv3-root 作用域（不绑 .zu3-hm 根类），日历根只补 flex 链与字号覆写。
       * 列宽=repeat(7,minmax(0,1fr)) 满幅：7 列天然均分容器宽（606px 内容宽每列
       * ≈81px），这是消除周列式「列帽 64px+居中」两侧大空白的机制（37 天=6 周列
       * 两侧各 ~100px 空白的 P0 截图根因）；行高=--zu-hm-rows 同款变量（2–6 行
       * flex 填满，v387 §11.6 month 结论沿用）。速度值 .zu3-cv 不设 color（把
       * .zu3-v 的前景白覆写为 inherit）——继承格上档位类 currentColor，档位色大字
       * 与混底同源一色（day-card .zu3-dcv v389 对比度结论沿用）；v395 §18.2 起空日
       * 不再渲染「无记录」轻字（只留日号+低对比底），.zu3-cnone 类退役。 */
      ".zu-sv3-root .zu3-cal{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}" +
      /* (.zu3-cal .zu-sc-wrap 的 flex 列链已并入 §15.3 居中合并规则，旧重复行删除) */
      ".zu-sv3-root .zu3-cal .zu3-cv{font-size:12px;color:inherit}" +
      /* v395 §18.1 紧凑日历（8–21 天）：行高帽 56px（完整日历 84px）+更紧 gap+小格内距
       * ——真正压缩短历史高度（场景 A 12 天 2–3 行不再留大空白），与 22–63 完整日历
       * 形成可测的视觉档位差异，不只是空类名。 */
      ".zu-sv3-root .zu3-cal-dense .zu3-hm-grid{max-height:calc(var(--zu-hm-rows,5)*56px);gap:4px}" +
      ".zu-sv3-root .zu3-cal-dense .zu3-hm-week{gap:4px;margin-bottom:2px}" +
      ".zu-sv3-root .zu3-cal-dense .zu-hm-cell{padding:2px 3px}" +
      /* ---------- 共用：模型色点 / 空态（图例行样式已随 v388 §12.6 删除） ---------- */
      ".zu-sv3-root .zu3-mdots,.zu-sv-portal .zu3-mdots{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto}" +
      ".zu-sv3-root .zu3-mdot,.zu-sv-portal .zu3-mdot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:0 0 auto}" +
      ".zu-sv3-root .zu3-mmore,.zu-sv-portal .zu3-mmore{font-size:7px;line-height:1;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
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
      /* v457：日/月悬停卡 Token 总消耗行——数值一行不折，拆分作次行小字 */
      ".zu-sv-portal .zu-sv3-ctok{white-space:nowrap;font-variant-numeric:tabular-nums}" +
      ".zu-sv-portal .zu-sv3-ctok small{display:block;font-size:9px;font-weight:400;" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* ---------- v457 §25：数值贴右 + token 行 + 按格分档（高与宽） ----------
       * 贴右：速度值（裸 .zu3-v / 日卡 .zu3-dcv / 值组 .zu3-vwrap）一律贴格右缘，
       * 日号仍左上、模型点仍右上。值组=速度+token 两行列内右对齐；组的垂直位置沿
       * 用各形态裸值的既有规则（日历格=margin:auto 0 在日号下方剩余空间居中、周列
       * 格=贴底、日卡=space-between），故 margin 与两条既有 .zu3-v{margin:auto 0}
       * 规则一一对应。token 行只在 tok 精确已知时产出，次要灰等宽数字。 */
      ".zu-sv3-root .zu3-v,.zu-sv3-root .zu3-dcv{align-self:flex-end;text-align:right}" +
      ".zu-sv3-root .zu3-vwrap{flex:0 0 auto;min-width:0;display:flex;flex-direction:column;align-items:flex-end;text-align:right}" +
      ".zu-sv3-root .zu3-hm-grid .zu3-vwrap,.zu-sv3-root .zu3-hh-mo .zu3-hh-grid .zu3-vwrap{margin:auto 0}" +
      ".zu-sv3-root .zu3-tk{flex:0 0 auto;max-width:100%;font-size:8px;line-height:1.15;font-weight:500;" +
        "font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu3-cal .zu3-tk{font-size:9px}" +
      ".zu-sv3-root .zu3-hh-grid .zu3-tk{font-size:7px}" +
      /* 分档：日历格（.zu3-hm-grid，本月/全部日历共用，名 zu3hc）与周/月列格
       * （.zu3-hh-grid，名 zu3hw）各设为尺寸容器——两种网格的行列轨道恒
       * minmax(0,1fr)/固定上下限，格尺寸由轨道定、不受内容影响，size containment
       * 不改轨道尺寸；日卡（.zu3-dc-grid，内容定高）不设容器。容器查询按格的内容盒
       * 计高宽（格高减内距）。速度永远保留：缩字只作用于带 token 行的值组（.zu3-vwrap
       * 内——无 token 的格观感不变），且限 token 可显示的高宽区间（与隐藏区间共边界，
       * 不出「token 被藏、速度却已缩」的两种字号）；格太矮或太窄时 token 行整行隐藏。
       * 宽度线两种容器不同（spec §25.2 宽度线修正），都按各形态实际写法的实测自然宽
       * 定档、每档留 ≥1.4px 余量。日历格用全文写法——「1234.57万」在 9px/7px/6.5px 下
       * 47.8/37.8/35.3px：≥49.5px 跟随高度档字号，39.5~49.5px 降到 7px，36.8~39.5px
       * 降到 6.5px，<36.8px 隐藏（高 ≤33px 的矮格在宽 ≥36.8px 时不受宽度档影响，恒 6.5px；首版一条
       * 30px 线，窄窗 620~700px 下 token 被裁成省略号）。周列/月列格走紧凑写法——「123.4万」在 7px/6.5px/6px 下 28.4/26.5/
       * 24.5px，「1234万」再窄 2.4px：≥30px 用 7px、28~30px 用 6.5px、26~28px 用 6px、
       * <26px 隐藏。周列 ≥16 列横向滚动后列宽钉在 34px（内容宽 28.2px）、月列 17/18 列
       * 内容宽 28.4/26.3px，沿用日历格的隐藏线会把这些常见历史长度的 token 行全藏；
       * 月列 19 列（内容宽 24.4px）仍放不下，隐藏。
       * 阈值=真实 Electron 夹具实测（spec §25.2）：日历格内容高 45.4/35.8/29（5/6/7
       * 行，日号行占 8px）；周列格无日号行（头部仅模型点 ≤6px），速度缩字线比日历格
       * 低 8px、隐藏线低 5px。
       * 边界不留缝（合并前审查实测，ZCode 4.0.0 = Electron 44 / Chrome 152 与夹具
       * Electron 45 同）：隐藏条件写成范围查询 `(width < Npx)`——N 以下恒隐藏、N 起不
       * 隐藏；缩字档下界会提前约 2/128px 为真，这段重叠由排在后面的隐藏规则胜出。上界
       * 若写成 `(max-width:N-0.1px)`，落在 (N-0.1, N) 里的格既不隐藏也不缩字，token 按
       * 原字号显示后被裁成省略号；写成 N-0.0001px 更糟——引擎对 max-/min- 的比较有约
       * 1/64px 的容差，`max-width:25.9999px` 会连 26px 的格一起隐藏。 */
      ".zu-sv3-root .zu3-hm-grid .zu-hm-cell{container-type:size;container-name:zu3hc}" +
      ".zu-sv3-root .zu3-hh-grid .zu-hm-cell{container-type:size;container-name:zu3hw}" +
      "@container zu3hc (max-height:39px) and (min-height:26.5px) and (min-width:36.8px){" +
        ".zu-sv3-root .zu3-tk,.zu-sv3-root .zu3-cal .zu3-tk{font-size:7px}}" +
      "@container zu3hw (max-height:25px) and (min-height:21.5px) and (min-width:26px){" +
        ".zu-sv3-root .zu3-vwrap .zu3-v{font-size:8px}" +
        ".zu-sv3-root .zu3-hh-grid .zu3-tk{font-size:6.5px}}" +
      /* 窄格宽度档：与高度缩字档同特异性，靠源序取胜。日历格的矮格高度档（≤33px，token
       * 6.5px 并缩速度）排在宽度档之后——矮格的竖直余量按 6.5px 标定，不能被宽度档的
       * 7px 抬回去；每格最终取到的是各命中档里最小的字号 */
      "@container zu3hc (width >= 39.5px) and (width < 49.5px){" +
        ".zu-sv3-root .zu3-tk,.zu-sv3-root .zu3-cal .zu3-tk{font-size:7px}}" +
      "@container zu3hc (width >= 36.8px) and (width < 39.5px){" +
        ".zu-sv3-root .zu3-tk,.zu-sv3-root .zu3-cal .zu3-tk{font-size:6.5px}}" +
      "@container zu3hc (max-height:33px) and (min-height:26.5px) and (min-width:36.8px){" +
        ".zu-sv3-root .zu3-vwrap .zu3-v{font-size:8px}" +
        ".zu-sv3-root .zu3-cal .zu3-vwrap .zu3-cv{font-size:10px}" +
        ".zu-sv3-root .zu3-tk,.zu-sv3-root .zu3-cal .zu3-tk{font-size:6.5px}}" +
      "@container zu3hw (width >= 28px) and (width < 30px){.zu-sv3-root .zu3-hh-grid .zu3-tk{font-size:6.5px}}" +
      "@container zu3hw (width >= 26px) and (width < 28px){.zu-sv3-root .zu3-hh-grid .zu3-tk{font-size:6px}}" +
      "@container zu3hc (height < 26.5px){.zu-sv3-root .zu3-tk{display:none}}" +
      "@container zu3hc (width < 36.8px){.zu-sv3-root .zu3-tk{display:none}}" +
      "@container zu3hw (height < 21.5px){.zu-sv3-root .zu3-tk{display:none}}" +
      "@container zu3hw (width < 26px){.zu-sv3-root .zu3-tk{display:none}}" +
      "</style>";
  }
  /* 本月日历热力（spec §5 month 行）：数据源=an.daysGrid（core 已产当月全日格集，
   * agg=null=空日/未来日，铺格由本层区分）。网格=7 列周日首列 × ceil((首日星期+
   * 天数)/7) 行；补位格（邻月占位）不可交互、未来日 aria-hidden 遮罩、无记录灰、
   * 有记录挂档位类（混底走 CSS）、今天描边。格内容=日号+日均速度（一位小数），
   * 右上模型点见 spd3DotsHTML。头图 sub=聚合粒度说明（模型身份说明走悬停卡构成行）。
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
          '" aria-label="' + spdEsc(spd3CellAria(g.t0, agg, o)) + '">' + head +
          spd3ValHTML("zu3-v", agg.v, spd3TokTxt(agg, o)) + "</div>");
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
      '<div class="zu3-hm-grid" role="grid" style="--zu-hm-rows:' + rows + '">' + body + "</div></div></div>";
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
    var single = !!(an.perModel && an.perModel.length === 1);
    var meta = spd3DayMeta(an.pool);
    /* ---- v389 §13.4 覆盖跨度 ≤6 自然日 → 紧凑日卡形态（spd3DayCardsHTML） ----
     * 判定轴=「池时间轴」：首日读 an.axisA（v389：core 未筛选原始池时间轴——
     * spanA 随筛选收缩会让形态在日卡/周网格间跳变，PRD 5.5 时间轴稳定），
     * 老帧缺 axisA 退化读 an.spanA，再缺回退 items 首日（旧行为轴）；轴末=
     * 取大者(今天, an.axisB/spanB 所在日)=今天（见下方钳制注释）。日历跨度=轴末−首日+1
     * 天（Math.round 折算 DST 23h/25h 日，口径同下方 totalDays）；≤6 切日卡，7+
     * 天走既有周网格/月聚合（两既有分支零改动）。着色仍按筛选（byDay 已是筛选后
     * 桶），跨度判定与筛选无关的语义由 axis 轴承载。 */
    var spanA0 = first, spanB0 = todayStart;
    var axisSrcA = (typeof an.axisA === "number" && isFinite(an.axisA) && an.axisA > 0) ? an.axisA : an.spanA;
    if (typeof axisSrcA === "number" && isFinite(axisSrcA) && axisSrcA > 0) {
      var sa3 = spdDate(axisSrcA);
      spanA0 = new Date(sa3.getFullYear(), sa3.getMonth(), sa3.getDate()).getTime();
    }
    var axisSrcB = (typeof an.axisB === "number" && isFinite(an.axisB) && an.axisB > 0) ? an.axisB : an.spanB;
    if (typeof axisSrcB === "number" && isFinite(axisSrcB) && axisSrcB > 0) {
      var sb3 = spdDate(axisSrcB);
      spanB0 = new Date(sb3.getFullYear(), sb3.getMonth(), sb3.getDate()).getTime();
    }
    if (spanA0 > todayStart) spanA0 = todayStart;   /* 时钟异常守卫：首日不晚于今天 */
    /* 轴末=取大者(今天, 末日日)：池行恒历史/当日，末日日零点不晚于今天，取大者恒
     * 今天——今天无记录也出灰卡（周网格「今天无数据=灰格照画」同口径）；外层 min
     * 钳卫异常未来值（周网格对 ds>todayStart 一律补位不铺格）。 */
    spanB0 = Math.min(Math.max(spanB0, todayStart), todayStart);
    var coverDays = Math.round((spanB0 - spanA0) / 864e5) + 1;
    /* v395 §18.1 活跃天数只做密度披露，绝不裁时间轴（axis 未筛选池已定跨度） */
    var activeDays = 0;
    for (var ad in byDay) if (byDay.hasOwnProperty(ad) && byDay[ad] && byDay[ad].v > 0) activeDays++;
    var layout = spd3SelectHistoryLayout({ spanDays: coverDays, activeDays: activeDays });
    var axis3 = { byDay: byDay, single: single, meta: meta,
      start: spanA0, end: spanB0, todayStart: todayStart, truncTxt: truncTxt + layout.sub,
      dense: layout.dense };
    if (layout.mode === "daycards")
      return spd3DayCardsHTML(an, hoverIdx, o, axis3);
    if (layout.mode === "cal")
      return spd3CalHTML(an, hoverIdx, o, axis3);
    /* 落到 hh：下方周列/月聚合既有分支零改动（判定轴同 axisA/spanA，形态不随筛选跳变） */
    var fd0 = spdDate(first);
    var fy = fd0.getFullYear(), fmo = fd0.getMonth(), fd = fd0.getDate();
    var totalDays = Math.round((todayStart - first) / 864e5) + 1;
    /* 网格起点=首数据日所在周的周日（行 r=0 恒周日，与 wds 行首标签对齐，V2 v292
     * column-major 教训沿用）；首数据日周中的偏移补位由 ds<first 分支产出 */
    var lead = new Date(fy, fmo, fd).getDay();
    var cols = Math.ceil((lead + totalDays) / 7);
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
            '" aria-label="' + spdEsc(spd3MonthAria(mb3, o)) + '">' + headMo +
            spd3ValHTML("zu3-v", mb3.v, spd3TokTxt(mb3, o, true)) + "</div>");
          tabMo = true;
        } else {
          moFlat.push('<div class="' + clsMo + '" role="gridcell" data-i="' + di2 +
            '" aria-label="' + spdEsc(spd3MonthAria(mb3 || { y: my, mo: mmo, v: null })) + '">' + headMo + "</div>");
        }
      }
      if (hoverIdx >= 0 && hoverIdx < moCols) {
        var mb4 = byMk[firstMk + hoverIdx];
        if (mb4 && mb4.v > 0) SPD_PORTAL = spd3MonthCardHTML(mb4, o);
      }
      var moRows = "";
      for (var r4 = 0; r4 < moFlat.length; r4++)
        moRows += '<div role="row" style="display:contents">' + moFlat[r4] + "</div>";
      /* §12.6 短月史居中：moCols ≤14 时根挂 zu3-hh-c（cols/grid 同规则居中），
       * >14 列维持 flex-start（月聚合长史铺满容器） */
      return '<div class="zu-speed-chart zu-sv-chart zu3-hh zu3-hh-mo' + (moCols <= 14 ? " zu3-hh-c" : "") +
        '">' + spd3HeatStyle() +
        spd3ChartHeadHTML(an, SPD_L("按月聚合", "aggregated by month") + axis3.truncTxt) +
        '<div class="zu3-hh-body">' +
        '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu3-hh-scroll">' +
        '<div class="zu3-hh-cols" style="--zu3-cols:' + moCols + '">' + moLabels + "</div>" +
        '<div class="zu3-hh-grid" role="grid" style="--zu3-cols:' + moCols + '">' + moRows + "</div>" +
        "</div></div></div></div>";
    }
    var sub = SPD_L("按日聚合", "aggregated by day") + axis3.truncTxt;
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
            '" aria-label="' + spdEsc(spd3CellAria(ds, it2, o)) + '">' + inner +
            spd3ValHTML("zu3-v", it2.v, spd3TokTxt(it2, o, true)) + "</div>");
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
    /* §12.6 短历史居中：cols ≤14 时根挂 zu3-hh-c（cols/grid 两容器同步居中，见
     * spd3HeatStyle 居中规则注释）；>14 列维持 flex-start 左对齐（有横滚意义） */
    return '<div class="zu-speed-chart zu-sv-chart zu3-hh' + (cols <= 14 ? " zu3-hh-c" : "") +
      '">' + spd3HeatStyle() +
      spd3ChartHeadHTML(an, sub) +
      '<div class="zu3-hh-body"><div class="zu3-hh-wds">' + spd3WeekRow() + "</div>" +
      '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu3-hh-scroll">' +
      '<div class="zu3-hh-cols" style="--zu3-cols:' + cols + '">' + labels + "</div>" +
      '<div class="zu3-hh-grid" role="grid" style="--zu3-cols:' + cols + '">' + rowsHtml + "</div>" +
      "</div></div></div></div>";
  }
  /* hist ≤6 自然日紧凑日卡（v389 §13.4/v391 §15.3，唯一消费者 spd3HistHTML 覆盖分支）：横排
   * 日期卡替代周网格——跨度 ≤6 天时周列×星期行只剩 1-2 列、周头/行头占掉近半高度。
   * axis={byDay, single, meta, start 首日零点, end 末日零点（≤今天）, todayStart,
   * truncTxt}。span 内每一天都有卡（含无数据日=「无记录」灰卡）：卡=日期 M/D 大字+
   * 周几+日均速度（档位色大字，.zu3-dcv 继承卡上档位类 currentColor）+模型点 ≤3+
   * 「+N」（spd3DotsHTML 复用）+档位 color-mix 混底（.zu-hm-data 既有规则）+今天
   * 描边（.zu-hm-today）。交互零宿主改动：卡挂 .zu-hm-cell+data-i=日序（本视图
   * 平铺序），宿主 mouseover/focus/keydown 委托按既有契约命中；悬停日卡=
   * spd3DayCardHTML 既有（无数据日不出卡，SPD_PORTAL 保持空串）。a11y：容器
   * role=grid、每卡包 display:contents 行（月聚合分支同款）、卡 role=gridcell，
   * tabindex 首卡 0 其余 -1（roving 翻转由 06/01 keydown 委托承担），aria=
   * spd3CellAria（完整日期+均速档位/无记录，绝不 0 t/s）。日进位一律 Date 构造器
   * （DST 安全），末毫秒 end=次日零点供悬停卡「全天/截至 HH:mm」区分。 */
  function spd3DayCardsHTML(an, hoverIdx, o, axis) {
    var byDay = axis.byDay, single = axis.single, meta = axis.meta;
    var start = axis.start, nDays = Math.round((axis.end - start) / 864e5) + 1;
    var s0 = spdDate(start);
    var sy = s0.getFullYear(), smo = s0.getMonth(), sd3 = s0.getDate();
    var cards = [], days = [];
    for (var i = 0; i < nDays; i++) {
      var ds = new Date(sy, smo, sd3 + i).getTime();   /* Date 构造器日进位，DST 安全 */
      var it = byDay[ds] || null, bd = it ? tpsBand(it.v) : null;
      var di = days.length;
      days.push({ t: ds, end: new Date(sy, smo, sd3 + i + 1).getTime(),
        agg: it, capped: !!meta.capByDay[ds] });
      var d3 = spdDate(ds);
      var cls = "zu-hm-cell zu3-dcc " + (it ? "zu-hm-data" + (bd ? " " + bd.cls : "") : "zu-hm-void") +
        (ds === axis.todayStart ? " zu-hm-today" : "");
      var head = '<span class="zu3-dchd"><span class="zu3-dcd">' + (d3.getMonth() + 1) + "/" + d3.getDate() +
        "</span>" + spd3DotsHTML(it, single) + "</span>" +
        '<span class="zu3-dcw">' + spdEsc(spd3Wd(d3.getDay())) + "</span>";
      /* v395 §18.2：空日卡只保留日期/星期+低对比底，不再重复「无记录」（禁止项 5）；
       * aria-label 仍表达无记录语义。完全无数据在 spd3HistHTML first===Infinity 分支走独立空态。 */
      var inner = it ? head + spd3ValHTML("zu3-dcv", it.v, spd3TokTxt(it, o)) : head;
      cards.push('<div role="row" style="display:contents"><div class="' + cls +
        '" role="gridcell" tabindex="' + (i === 0 ? "0" : "-1") + '" data-i="' + di +
        '" aria-label="' + spdEsc(spd3CellAria(ds, it, o)) + '">' + inner + "</div></div>");
    }
    if (hoverIdx >= 0 && hoverIdx < nDays && days[hoverIdx] && days[hoverIdx].agg)
      SPD_PORTAL = spd3DayCardHTML({ t: days[hoverIdx].t, b: Math.min(days[hoverIdx].end, Date.now()),
        agg: days[hoverIdx].agg, capped: days[hoverIdx].capped,
        tn: meta.tnByDay[days[hoverIdx].t] || null, di: hoverIdx }, o);
    return '<div class="zu-speed-chart zu-sv-chart zu3-dc">' + spd3HeatStyle() +
      spd3ChartHeadHTML(an, SPD_L("按日 · 覆盖 " + nDays + " 天",
        "daily · " + nDays + (nDays === 1 ? " day" : " days") + " covered") + axis.truncTxt) +
      '<div class="zu-sc-wrap"><div class="zu3-dc-grid" role="grid">' + cards.join("") + "</div></div></div>";
  }
  /* hist 七列日历式（v390 §14.3/v391 §15.3，唯一消费者 spd3HistHTML 密度分派）：覆盖 7–60 天时替代周列贡献式——周列式列帽 64px 下短跨度
   * 列少居中、两侧大空白（37 天=6 列实测两侧各 ~100px）；日历式 7 列 minmax(0,1fr)
   * 满幅均分容器宽，与跨度无关。month 组件同构复用（span 代替当月）：网格=7 列周日
   * 首列 × 覆盖自然周行（行数=ceil((首日星期偏移+跨度)/7)，2–7 行，经 --zu-hm-rows
   * 下发 flex 填满），首日所在周周日起、末日所在周周六止**完整覆盖跨度**；span 前
   * 补位格 zu-hm-pad（邻周占位不可交互，month 同款）、span 内逐格渲染、**span 外
   * 不渲染**（轴末恒钳今天，末行尾随未来位置直接留白不出未来格）。格=日号（跨月
   * 首日带月标记 M/D、跨年首日带年 YYYY/M/D——日历无月列头，靠格内标记消歧）+
   * 日均速度（.zu3-cv 档位色大字，继承格上档位类 currentColor）+模型点 ≤3+「+N」
   * （spd3DotsHTML 复用）+档位 color-mix 混底（.zu-hm-data 既有规则）+今天描边
   * （.zu-hm-today）；span 内无数据日灰格只留日号（.zu-hm-void，v395 §18.2 不再写
   * 「无记录」轻字，.zu3-cnone 退役）。
   * 交互/a11y 全沿既有契约零宿主改动：容器 role=grid、行 display:contents（month
   * 同款）、格 role=gridcell+data-i=日序（平铺序，补位不占号，周网格同口径）、
   * roving tabindex 首个有值格 0 其余 -1（方向键由 06/01 keydown 委托承担）、
   * aria=spd3CellAria（完整日期+均速档位/无记录，绝不 0 t/s）；悬停/键盘经宿主
   * .zu-hm-cell 委托命中，悬停日卡=spd3DayCardHTML 既有（无数据日不出卡）。
   * 日进位一律 Date 构造器（DST 安全，禁固定 864e5 步长）。axis={byDay, single,
   * meta, start 首日零点, end 末日零点（=今天）, todayStart, truncTxt}，与
   * spd3DayCardsHTML 同构。 */
  function spd3CalHTML(an, hoverIdx, o, axis) {
    var byDay = axis.byDay, single = axis.single, meta = axis.meta;
    var start = axis.start, todayStart = axis.todayStart;
    var nDays = Math.round((axis.end - start) / 864e5) + 1;
    var s0 = spdDate(start);
    var sy = s0.getFullYear(), smo = s0.getMonth(), sd3 = s0.getDate();
    var lead = new Date(sy, smo, sd3).getDay();   /* 周日=0 → 首列周日对齐（项目既有约定） */
    var rows = Math.ceil((lead + nDays) / 7);
    var flat = [], days = [], tabSet3 = false;
    for (var p = 0; p < rows * 7; p++) {
      var ds = new Date(sy, smo, sd3 - lead + p).getTime();   /* Date 构造器日进位，DST 安全 */
      if (ds < start) { flat.push('<i class="zu-hm-pad" aria-hidden="true"></i>'); continue; }
      if (ds > todayStart) break;   /* span 外不渲染：末行尾随未来位置留白，绝不出未来格 */
      var it = byDay[ds] || null, bd = it ? tpsBand(it.v) : null;
      var di = days.length;
      /* end=次日零点（Date 构造器日进位，DST 安全）：悬停日卡时间行据此区分
       * 「全天 / 截至 HH:mm」（今天桶 b 由调用点钳到 now，spec §11.5） */
      days.push({ t: ds, end: new Date(sy, smo, sd3 - lead + p + 1).getTime(),
        agg: it, capped: !!meta.capByDay[ds] });
      var d3 = spdDate(ds);
      /* 日号：跨月首日带月标记 M/D、跨年首日带年 YYYY/M/D */
      var dn = String(d3.getDate());
      if (d3.getDate() === 1) dn = (d3.getMonth() + 1) + "/" + dn;
      if (d3.getDate() === 1 && d3.getMonth() === 0) dn = d3.getFullYear() + "/" + dn;
      var cls = "zu-hm-cell " + (it ? "zu-hm-data" + (bd ? " " + bd.cls : "") : "zu-hm-void") +
        (ds === todayStart ? " zu-hm-today" : "");
      var head = '<span class="zu3-hd"><span class="zu3-d">' + dn + "</span>" + spd3DotsHTML(it, single) + "</span>";
      /* v395 §18.2：空日只保留日号+低对比底，不再逐格重复「无记录」文字（禁止项 5）；
       * aria-label 仍由 spd3CellAria(ds,null) 表达无记录语义，无障碍不丢。 */
      var val = it ? spd3ValHTML("zu3-v zu3-cv", it.v, spd3TokTxt(it, o)) : "";
      if (it) {
        flat.push('<div class="' + cls + '" role="gridcell" tabindex="' + (tabSet3 ? "-1" : "0") + '" data-i="' + di +
          '" aria-label="' + spdEsc(spd3CellAria(ds, it, o)) + '">' + head + val + "</div>");
        tabSet3 = true;
      } else {
        flat.push('<div class="' + cls + '" role="gridcell" data-i="' + di +
          '" aria-label="' + spdEsc(spd3CellAria(ds, null)) + '">' + head + "</div>");
      }
    }
    /* 悬停日卡经 SPD_PORTAL 侧信道（与 month/周网格同款；无数据日/越界序号=空串） */
    if (hoverIdx >= 0 && hoverIdx < days.length && days[hoverIdx] && days[hoverIdx].agg)
      SPD_PORTAL = spd3DayCardHTML({ t: days[hoverIdx].t, b: Math.min(days[hoverIdx].end, Date.now()),
        agg: days[hoverIdx].agg, capped: days[hoverIdx].capped,
        tn: meta.tnByDay[days[hoverIdx].t] || null, di: hoverIdx }, o);
    var body = "";
    for (var r2 = 0; r2 < rows; r2++)
      body += '<div role="row" style="display:contents">' + flat.slice(r2 * 7, r2 * 7 + 7).join("") + "</div>";
    return '<div class="zu-speed-chart zu-sv-chart zu3-cal' + (axis.dense ? " zu3-cal-dense" : "") + '">' + spd3HeatStyle() +
      spd3ChartHeadHTML(an, SPD_L("按日 · 日历视图", "daily · calendar") + axis.truncTxt) +
      '<div class="zu-sc-wrap"><div class="zu3-hm-week">' + spd3WeekRow() + "</div>" +
      '<div class="zu3-hm-grid" role="grid" style="--zu-hm-rows:' + rows + '">' + body + "</div></div></div>";
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
      (bd ? " " + bd.cls : "") + '">' + spdEsc(spd3Fmt1(agg.v)) + SPD_L(" t/s", " t/s") + "</b></div>" +
      spd3TokRowHTML(agg, o);
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
   * 性尾注，不编数字）。v457：月桶另累计 i/o 与 tok（任一日 tok 未知 → 月 tok=null，
   * 月格不出 token 行、月卡不出 token 行，绝不拿已知日冒充整月）。 */
  function spd3MonthBuckets(items, capByDay) {
    var byM = {}, keys = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.empty || !it.a) continue;
      var d = spdDate(it.a), mk = d.getFullYear() * 12 + d.getMonth();
      var mb = byM[mk];
      if (!mb) {
        mb = byM[mk] = { y: d.getFullYear(), mo: d.getMonth(), out: 0, ms: 0, n: 0, days: 0, models: {}, capped: false,
          i: 0, o: 0, tok: 0, tokFull: true };
        keys.push(mk);
      }
      mb.out += it.out; mb.ms += it.ms; mb.n += spdNum(it.n); mb.days++;
      mb.i += spdNum(it.i); mb.o += spdNum(it.o);
      if (it.tok === null || it.tok === undefined) mb.tokFull = false; else mb.tok += it.tok;
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
        out: b2.out, ms: b2.ms, n: b2.n, days: b2.days, models: ml, capped: b2.capped,
        i: b2.i, o: b2.o, tok: b2.tokFull ? b2.tok : null });
    }
    return months;
  }
  /* 月悬停卡（SPD_PORTAL 内容生产者，纯字符串，spec §11.6）：标题「YYYY年M月 ·
   * 月度统计」；区间行（进行月=「YYYY/M/1 00:00 – 截至 MM-DD HH:mm」，已结束月=
   * 「YYYY/M · 全月」，规则同 §11.5 日卡、动态取钳后 b）；月均速度（档位色）；
   * 「N 天有记录 / M 次请求」；模型构成=各模型 Σout 占比前 3 +「另有 N 个模型」，
   * 月桶无每模型分量（降级帧）时整段如实省略；capped 定性尾注。空月/无有效速度 →
   * 空串不出卡。动态内容（模型名）一律 spdEsc 转义。 */
  function spd3MonthCardHTML(mb, o) {
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
      mb.n + SPD_L(" 次请求", " requests") + "</span></div>" + spd3TokRowHTML(mb, o);
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
