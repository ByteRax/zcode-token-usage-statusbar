  /* ---------- v384 生成速度 Tooltip V3：卡外壳视图层（spd3 纯字符串构建器，零 DOM） ----------
   * spec = specs/speed-tooltip-v3.md §6（920×480 布局）+ §3（chips/弹出层）+ §7（i18n/转义）。
   * 本分片是 V3 卡的全部 HTML/CSS 外壳：头部双 Tab 组、模型筛选条与搜索弹出层、左摘要卡
   * （单/多模型两态）、图表标题栏与整卡装配。图表本体（柱/线/热力）由 charts/heat 分片
   * 产出，经 spd3CardHTML 的 <!--CHART--> 占位替换注入——本文件恒原样保留该占位符。
   * 数据上游 = 04-speed-v3-core.js 的 spd3Analyze（an 只读，绝不原地改）。
   * 只引用更早分片的存活符号：L / SPD_L / TPS_BANDS / tpsBand / tpsBandText / spdEsc /
   * spdNum / spd2 / spdDate / spdFull / spdRangeText / spdRangeFull / SPD_RANGES /
   * SPD_PERIODS / SPD_BARS_MAX + core 的 spd3*（spd3Color / SPD3_PALETTE / spd3ModelKey /
   * spd3FilterSig / spd3FilterAuto 等）。V2 专属函数（spdAnalyze / spdLeftHTML /
   * spdHeadHTML / spdTabRow / spdChartHeadHTML / speedCardV2HTML 等）随 V3 上线删除，
   * 一律不引用；视觉基准取自 V2 同名结构，但样式全部自带——.zu-sv3-root 作用域的内联
   * <style>（.zu-light 祖先类切浅色），不依赖 06 分片的 V2 专属规则，V2 删除后零残留。
   * 纪律（spec §7）：模型 key 不进 className（只进 data-k）；动态文本一律 spdEsc；全部
   * 文案走 SPD_L；颜色语义两套不混用——模型身份色 = spd3Color（SPD3_PALETTE），速度
   * 色阶 = TPS_BANDS 档位类（zu-ultra/ok/warm… 全局色规则继承）。
   * 集成契约：spd3LeftHTML 第三参 expanded（多模型分布表展开态，调用方传布尔）；覆盖
   * 范围五值读可选 an.cov={recent,today,week,month,all}（集成方按五个 period 各跑一次
   * spd3AnalyzeCached 汇总轮数，缺席显 —）；筛选 chips 池缺省取 an.perModel+an.selMissing，
   * 筛选激活时集成方应传 ctx.pool=未筛选全量模型（否则 chips 收缩为已选集，无法点回）。 */
  /* SPD_V3_VIEW_BEGIN */
  var SPD3_SVG_FUNNEL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z"/></svg>';
  var SPD3_SVG_SEARCH = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  var SPD3_SVG_CUBE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>';
  /* 数值格式沿用 V2 口径：整数直显、小数留 1 位、空值 em dash（绝不显 0 t/s） */
  function spd3FmtV(x) { return x == null ? "—" : (x % 1 ? x.toFixed(1) : String(x)); }
  /* chips/弹出行共用：色点 + 名称（超长 ellipsis，全文走 title） */
  function spd3DotAndName(key, name) {
    return '<i class="zu-sv3-dot" style="background:' + spd3Color(key) + '" aria-hidden="true"></i>' +
      '<span class="zu-sv3-chip-name">' + spdEsc(name) + "</span>";
  }
  /* 缺失 key 的显示名：身份键 = provider\x1fmodel（provider 缺失为空段），取 model 段；
   * 无 \x1f 整串即名（名称退化键 "n\x1fname" 同规则）；空段兜底「未知模型」。 */
  function spd3KeyName(key) {
    var s = String(key == null ? "" : key), cut = s.indexOf("\x1f");
    var mid = cut >= 0 ? s.slice(cut + 1) : s;
    return mid || SPD_L("未知模型", "Unknown model");
  }
  /* ==================== ① 头部：标题 + 范围/时间双 Tab 组（V2 spdTabRow/spdHeadHTML 同构改名） ==================== */
  function spd3TabRow(group, list, cur, labels) {
    var out = '<div class="zu-sv-tabs" data-sv-group="' + group + '">';
    for (var i = 0; i < list.length; i++) {
      out += '<button type="button" class="zu-sv-tab' + (list[i] === cur ? " on" : "") +
        '" data-sv-group="' + group + '" data-sv-val="' + spdEsc(list[i]) + '"' +
        (list[i] === cur ? ' aria-pressed="true"' : ' aria-pressed="false"') + ">" +
        spdEsc(labels[list[i]]) + "</button>";
    }
    return out + "</div>";
  }
  function spd3HeadHTML(an) {
    an = an || {};
    var rl = { recent: SPD_L("最近", "Recent"), session: SPD_L("会话", "Session"),
      project: SPD_L("项目", "Project"), all: SPD_L("全部", "All") };
    var pl = { recent: SPD_L("最近", "Recent"), today: SPD_L("今天", "Today"),
      week: SPD_L("近 7 天", "7 days"), month: SPD_L("本月", "Month"), all: SPD_L("全部", "All") };
    return '<div class="zu-sv-head"><div class="zu-sv-title">📈 ' + spdEsc(SPD_L("生成速度", "Generation speed")) + "</div>" +
      '<div class="zu-sv-filter"><span class="zu-sv-flabel">' + spdEsc(SPD_L("范围", "Scope")) + "</span>" +
      spd3TabRow("range", SPD_RANGES, an.range, rl) +
      '<span class="zu-sv-time"><span class="zu-sv-flabel">' + spdEsc(SPD_L("时间", "Time")) + "</span>" +
      spd3TabRow("period", SPD_PERIODS, an.period, pl) + "</span></div></div>";
  }
  /* ==================== ② 筛选条（spec §3）：漏斗 + chips + 计数 + 搜索入口 ====================
   * pool = [{key,name,n?,missing?}]（spd3ChipPool 产出）；o = {selMissing?, pop?}。
   * 选中态 = filt.mode==="sel" 且含该 key；无数据模型（missing / o.selMissing 命中，
   * 含 pool 外的 selMissing key 兜底补一枚）加 .zu-sv3-chip-empty + 「无数据」标记。
   * ≤6 枚全显、超出收 +N；≥9 模型才渲染搜索按钮；pool 为空不渲染整条。 */
  function spd3FilterBarHTML(pool, filt, o) {
    pool = pool || [];
    o = o || {};
    var rows = pool.slice(), seen = {}, i;
    for (i = 0; i < rows.length; i++) seen[rows[i].key] = true;
    var miss = o.selMissing || [];
    for (i = 0; i < miss.length; i++) if (!seen[miss[i]]) {
      seen[miss[i]] = true;
      rows.push({ key: miss[i], name: spd3KeyName(miss[i]), missing: true });
    }
    if (!rows.length) return "";
    var isOn = function (k) { return !!(filt && filt.mode === "sel" && filt.keys && filt.keys.indexOf(k) >= 0); };
    var chips = "", MAX = 6, onCount = 0;
    for (i = 0; i < rows.length && i < MAX; i++) {
      var p = rows[i], on = isOn(p.key), empty = !!p.missing || miss.indexOf(p.key) >= 0;
      if (on) onCount++;
      chips += '<button type="button" class="zu-sv3-chip' + (on ? " on" : "") + (empty ? " zu-sv3-chip-empty" : "") +
        '" data-k="' + spdEsc(p.key) + '"' + (on ? ' aria-pressed="true"' : ' aria-pressed="false"') +
        ' title="' + spdEsc(p.name) + '" aria-label="' + spdEsc(p.name + (empty ? SPD_L("（无数据）", " (no data)") : "")) + '">' +
        spd3DotAndName(p.key, p.name) +
        (empty ? '<em class="zu-sv3-chip-miss">' + spdEsc(SPD_L("无数据", "no data")) + "</em>" : "") + "</button>";
    }
    var hidden = rows.length - Math.min(rows.length, MAX);
    if (hidden > 0) chips += '<span class="zu-sv3-chip-more" title="' +
      spdEsc(SPD_L("其余 " + hidden + " 个模型，可搜索查看", hidden + " more models — use search")) + '">+' + hidden + "</span>";
    var selCount = filt && filt.mode === "sel" && filt.keys ? filt.keys.length : rows.length;
    var count = filt && filt.mode === "sel"
      ? SPD_L("已选 " + selCount + "/" + rows.length, "Selected " + selCount + "/" + rows.length)
      : SPD_L("全部 " + rows.length, "All " + rows.length);
    var search = rows.length >= 9 ? '<button type="button" class="zu-sv3-fsearch" aria-haspopup="dialog" aria-expanded="' +
      (o.pop && o.pop.open ? "true" : "false") + '" title="' + spdEsc(SPD_L("搜索模型", "Search models")) +
      '" aria-label="' + spdEsc(SPD_L("搜索模型", "Search models")) + '">' + SPD3_SVG_SEARCH + "</button>" : "";
    return '<div class="zu-sv3-fbar"><span class="zu-sv3-fico">' + SPD3_SVG_FUNNEL + "</span>" +
      '<span class="zu-sv3-flabel">' + spdEsc(SPD_L("模型筛选", "Model filter")) + "</span>" +
      '<div class="zu-sv3-chips">' + chips + "</div>" +
      '<span class="zu-sv3-fcount">' + spdEsc(count) + "</span>" + search + "</div>";
  }
  /* ==================== ③ 筛选弹出层（spec §3 ≥9 模型）：搜索 + 列表 + 全选/清空/恢复默认 ====================
   * 行 button 带 data-k（选中态 aria-pressed）；query 按名称/身份键不区分大小写过滤，
   * >60 行只渲染前 60 并提示「输入以搜索更多」（轻量截断，不做虚拟化）。 */
  function spd3FilterPopHTML(pool, filt, query) {
    pool = pool || [];
    var q = String(query == null ? "" : query).toLowerCase();
    var rows = [];
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      if (q && String(p.name).toLowerCase().indexOf(q) < 0 && String(p.key).toLowerCase().indexOf(q) < 0) continue;
      rows.push(p);
    }
    var CAP = 60, capped = rows.length > CAP;
    if (capped) rows = rows.slice(0, CAP);
    var isOn = function (k) { return !!(filt && filt.mode === "sel" && filt.keys && filt.keys.indexOf(k) >= 0); };
    var list = "";
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j], on = isOn(r.key);
      list += '<button type="button" class="zu-sv3-fpop-row' + (on ? " on" : "") + '" data-k="' + spdEsc(r.key) + '"' +
        (on ? ' aria-pressed="true"' : ' aria-pressed="false"') + ' title="' + spdEsc(r.name) + '">' +
        spd3DotAndName(r.key, r.name) +
        '<span class="zu-sv3-fpop-n">' + spdEsc(String(spdNum(r.n))) + "</span></button>";
    }
    var box = '<input type="text" class="zu-sv3-fpop-input" aria-label="' + spdEsc(SPD_L("搜索模型", "Search models")) +
      '" placeholder="' + spdEsc(SPD_L("搜索模型…", "Search models…")) + '" value="' +
      spdEsc(query == null ? "" : String(query)) + '">';
    var acts = '<div class="zu-sv3-fpop-acts">' +
      '<button type="button" class="zu-sv3-fpop-btn" data-sv3-all>' + spdEsc(SPD_L("全选", "Select all")) + "</button>" +
      '<button type="button" class="zu-sv3-fpop-btn" data-sv3-none>' + spdEsc(SPD_L("清空", "Clear")) + "</button>" +
      '<button type="button" class="zu-sv3-fpop-btn" data-sv3-reset>' + spdEsc(SPD_L("恢复默认", "Reset")) + "</button></div>";
    return '<div class="zu-sv3-fpop" role="dialog" aria-label="' + spdEsc(SPD_L("模型筛选", "Model filter")) + '">' + box +
      '<div class="zu-sv3-fpop-list">' + (list ||
        '<div class="zu-sv3-fpop-cap">' + spdEsc(SPD_L("无匹配模型", "No matching models")) + "</div>") + "</div>" +
      (capped ? '<div class="zu-sv3-fpop-cap">' + spdEsc(SPD_L("输入以搜索更多", "Type to search more")) + "</div>" : "") +
      acts + "</div>";
  }
  /* ==================== ④ 左摘要卡（spec §6 单/多模型两态） ====================
   * 单模型判定 = an.perModel（筛选后池内有输出分量模型）恰 1 个（无数据模型不计）。
   * 多模型分布行序按 share（请求数占比）降序、最多 6 行 + data-sv3-more 展开按钮
   * （expanded 由调用方传）；msAvail=false 降级：隐藏「均速」列（表格退两列），
   * 绝不出现 t/s 假值。覆盖范围单值随 an.period 直读（v384 M4：an.cov 五值契约废除）。 */
  function spd3LeftTitle(an) {
    var n = an && an.items ? an.items.length : 0;
    var t = an && an.period === "recent" ? SPD_L("最近 " + n + " 轮", "Last " + n + " turns")
      : an && an.period === "today" ? SPD_L("今天", "Today")
      : an && an.period === "week" ? SPD_L("近 7 天", "Last 7 days")
      : an && an.period === "month" ? SPD_L("本月", "This month")
      : SPD_L("历史", "History");   /* v384 S6-MINOR6：设计稿措辞「历史平均速度」 */
    return t + SPD_L("平均速度", " · average speed");
  }
  function spd3StatHTML(lb, x, dayLabel) {
    var b2 = x && x.v != null ? tpsBand(x.v) : null;
    return '<span class="zu-sv3-stat"><i>' + spdEsc(dayLabel || lb) + "</i><b" +
      (b2 ? ' class="' + b2.cls + '"' : "") + ">" + spdEsc(spd3FmtV(x ? x.v : null)) + "</b></span>";
  }
  function spd3BandHTML(bd) {
    return '<div class="zu-sv3-band"><b class="' + bd.cls + '" style="font-weight:600">' +
      spdEsc(tpsBandText(bd)) + "</b></div>";
  }
  function spd3LeftHTML(an, live, expanded) {
    an = an || {};
    var overall = an.overall || null;
    var models = an.perModel || [];
    var bd = overall ? tpsBand(overall.v) : null;
    var dayLbl = an.unit === "day";
    var headRow = '<div class="zu-sv3-title-row"><span class="zu-sv3-ltitle">' + spdEsc(spd3LeftTitle(an)) + "</span>" +
      (live && live.statusText ? '<span class="zu-sv3-sub">' + spdEsc(live.statusText) + "</span>" : "") + "</div>";
    var stats = '<div class="zu-sv3-stats">' +
      spd3StatHTML(SPD_L("峰值", "Peak"), an.peak, dayLbl ? SPD_L("最高日均", "Best daily") : "") +
      spd3StatHTML(SPD_L("最低", "Low"), an.low, dayLbl ? SPD_L("最低日均", "Worst daily") : "") +
      spd3StatHTML(SPD_L("最新", "Latest"), an.latest, dayLbl ? SPD_L("最近日均", "Latest daily") : "") + "</div>";
    if (!models.length || !overall) {
      /* 空池/显式空筛选：标题 + em dash 主数字 + 峰最低最新，绝不造 0 t/s */
      return '<div class="zu-sv3-left">' + headRow +
        '<div class="zu-sv3-main-num"><span class="dim">—</span><span class="zu-sv3-unit">t/s</span></div>' + stats + "</div>";
    }
    if (models.length === 1) {
      var m = models[0];
      /* v384 M4：覆盖范围单值直读本视图（an.cov 五值生产者无人实现，砍掉）；
       * m3：补「本期统计」组标题（设计稿单模型态三行 kv 的分组标签） */
      var covLbl = an.period === "recent" ? SPD_L("最近 " + (an.items ? an.items.length : 0) + " 轮", "Last " + (an.items ? an.items.length : 0) + " turns")
        : an.period === "today" ? SPD_L("今天", "Today")
        : an.period === "week" ? SPD_L("近 7 天", "Last 7 days")
        : an.period === "month" ? SPD_L("本月", "This month")
        : SPD_L("全部历史", "All history");
      return '<div class="zu-sv3-left">' + headRow +
        '<div class="zu-sv3-main-num"><span class="' + (bd ? bd.cls : "dim") + '">' + spdEsc(spd3FmtV(overall.v)) +
        '</span><span class="zu-sv3-unit">t/s</span></div>' +
        (bd ? spd3BandHTML(bd) : "") +
        '<div class="zu-sv3-model">' + spd3DotAndName(m.key, m.name) +
        '<em class="zu-sv3-only">' + spdEsc(SPD_L("唯一模型", "Only model")) + "</em></div>" +
        '<i class="zu-sv3-cov-h">' + spdEsc(SPD_L("本期统计", "This period")) + "</i>" +
        '<div class="zu-sv3-kv"><i>' + spdEsc(SPD_L("请求轮次", "Turns")) + "</i><b>" +
        spdEsc(spdNum(overall.turns) + SPD_L("轮", " turns")) + "</b></div>" +
        '<div class="zu-sv3-kv"><i>' + spdEsc(SPD_L("当前模型", "Model")) + '</i><b title="' + spdEsc(m.name) + '">' +
        spdEsc(m.name) + "</b></div>" +
        '<div class="zu-sv3-kv"><i>' + spdEsc(SPD_L("覆盖范围", "Coverage")) + "</i><b>" + spdEsc(covLbl) + "</b></div>" +
        stats + "</div>";
    }
    /* ---- 多模型态：计数行 → 档位胶囊 → 所选模型分布（堆叠条+表格）→ 峰最低最新 ---- */
    var shareSorted = models.slice().sort(function (a, b) { return (b.share || 0) - (a.share || 0); });
    var turns = spdNum(overall.turns);
    var bar = "";
    for (var bi = 0; bi < shareSorted.length; bi++) {
      var bm = shareSorted[bi];
      bar += '<i style="background:' + spd3Color(bm.key) + ";width:" + (Math.max(0, (bm.share || 0) * 100)) + '%"></i>';
    }
    var msAvail = an.msAvail !== false;
    var thead = "<tr><th>" + spdEsc(SPD_L("模型", "Model")) + "</th>" +
      (msAvail ? "<th>" + spdEsc(SPD_L("均速", "Avg speed")) + "</th>" : "") +
      "<th>" + spdEsc(SPD_L("占比", "Share")) + "</th></tr>";
    var shown = expanded ? shareSorted : shareSorted.slice(0, 6);
    var rowsHtml = "";
    for (var ri = 0; ri < shown.length; ri++) {
      var rm = shown[ri];
      rowsHtml += '<tr><td><span class="zu-sv3-dmodel">' + spd3DotAndName(rm.key, rm.name) + "</span></td>" +
        (msAvail ? "<td>" + (rm.tps != null ? spdEsc(spd3FmtV(rm.tps) + SPD_L(" t/s", " t/s")) : "—") + "</td>" : "") +
        '<td class="zu-sv3-pct">' + spdEsc(String(Math.round((rm.share || 0) * 1000) / 10)) + "%</td></tr>";
    }
    var more = "";
    if (shareSorted.length > 6) {
      more = '<button type="button" class="zu-sv3-more" data-sv3-more aria-expanded="' + (expanded ? "true" : "false") + '">' +
        spdEsc(expanded ? SPD_L("收起", "Show less")
          : SPD_L("展开全部 " + shareSorted.length + " 个模型", "Show all " + shareSorted.length + " models")) + "</button>";
    }
    return '<div class="zu-sv3-left">' + headRow +
      '<div class="zu-sv3-count">' + SPD3_SVG_CUBE + "<span>" +
      spdEsc(SPD_L("已选 " + models.length + " 个模型 · " + turns + " 轮",
        models.length + " models · " + turns + " turns")) + "</span></div>" +
      (bd ? spd3BandHTML(bd) : "") +
      '<div class="zu-sv3-dist-h">' + spdEsc(SPD_L("所选模型分布 · 按请求数", "Selected models · by requests")) + "</div>" +
      '<div class="zu-sv3-dbar" aria-hidden="true">' + bar + "</div>" +
      '<table class="zu-sv3-dtab">' + thead + rowsHtml + "</table>" + more + stats + "</div>";
  }
  /* ==================== ⑤ 通知行（spec §6 仅在有内容时渲染，非常驻说明条） ====================
   * core 管线已把 selMissing 计数并入 an.notice（「已选 N 个模型中 M 个在当前范围无
   * 数据」），这里直接透传避免重复上报；仅当 notice 缺席而 selMissing 在场（部分
   * 构造的 an）时合成兜底句。 */
  function spd3NoticeHTML(an) {
    if (!an) return "";
    if (an.notice) return an.notice;
    var miss = an.selMissing && an.selMissing.length ? an.selMissing.length : 0;
    if (miss) return SPD_L(miss + " 个所选模型在当前范围无数据", miss + " selected models have no data in this scope");
    return "";
  }
  /* ==================== ⑥ 图表标题栏（V2 spdChartHeadHTML 同构：标题+t/s+档位入口+区间） ==================== */
  function spd3ChartHeadHTML(an, sub) {
    an = an || {};
    var ico = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>';
    /* Speed Bands SVG（细圆环 + 三级递增速度柱）逐字沿用 V2，档位说明浮层链（spdLegendTip）不变 */
    var qico = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="10" cy="10" r="8.15" stroke="currentColor" stroke-width="1.3" stroke-opacity="0.72"/>' +
      '<path d="M6.35 13.2V10.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.68"/>' +
      '<path d="M10 13.2V8.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.88"/>' +
      '<path d="M13.65 13.2V6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      "</svg>";
    return '<div class="zu-sc-head"><span class="zu-sc-title">' + spdEsc(an.title || "") + "</span>" +
      '<span class="zu-sc-unit">t/s</span>' +
      '<button type="button" class="zu-sv-legend-btn" data-sv-band="' + (an.overall ? tpsBand(an.overall.v).cls : "") +
      '" aria-haspopup="true" aria-expanded="false" title="' + spdEsc(SPD_L("查看速度档位说明", "View speed bands")) +
      '" aria-label="' + spdEsc(SPD_L("查看速度档位说明", "View speed bands")) + '">' + qico + "</button>" +
      (sub ? '<span class="zu-sc-sub zu-hm-sub">' + spdEsc(sub) + "</span>" : "") +
      '<span class="zu-sv-range" title="' + spdEsc(spdRangeFull(an.spanA, an.spanB)) + '">' + ico +
      "<span>" + spdEsc(spdRangeText(an.spanA, an.spanB)) + "</span></span></div>";
  }
  /* ==================== ⑦ 内联样式块（全部 .zu-sv3-root 作用域；.zu-light 祖先类切浅色） ==================== */
  function spd3StylesHTML() {
    return "<style>" +
      /* 根：920×480 基准定宽，高度自适应；--zu-sv3-w/--zu-sv3-h 暴露给集成方钳制 */
      ".zu-sv3-root{position:relative;display:flex;flex-direction:column;box-sizing:border-box;" +
        "width:var(--zu-sv3-w,min(920px,calc(100vw - 24px)));min-height:min(480px,calc(100vh - 16px));" +
        "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
        "color:var(--color-foreground,#e9edf4)}" +
      ".zu-sv3-root,.zu-sv3-root *{box-sizing:border-box}" +
      ".zu-light .zu-sv3-root{color:var(--color-foreground,#1c212b)}" +
      /* ---- 头部：标题居左，范围/时间双 Tab 组整体靠右（V2 .zu-sv-head 视觉契约） ---- */
      ".zu-sv3-root .zu-sv-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin-bottom:10px}" +
      ".zu-sv3-root .zu-sv-title{font-weight:700;font-size:calc(var(--ui-font-size,14px) + 6px);letter-spacing:.2px;min-width:0}" +
      ".zu-sv3-root .zu-sv-filter{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-left:auto;justify-content:flex-end}" +
      ".zu-sv3-root .zu-sv-flabel{font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);flex:0 0 auto}" +
      ".zu-sv3-root .zu-sv-time{display:flex;align-items:center;gap:6px;margin-left:14px}" +
      ".zu-sv3-root .zu-sv-tabs{display:flex;flex:0 1 auto;flex-wrap:wrap;gap:2px;padding:2px;border-radius:9px;" +
        "background:rgba(255,255,255,.045);border:1px solid var(--color-popover-border,rgba(255,255,255,.1))}" +
      ".zu-light .zu-sv3-root .zu-sv-tabs{background:rgba(0,0,0,.04)}" +
      ".zu-sv3-root .zu-sv-tab{appearance:none;border:0;background:transparent;color:var(--color-tooltip-tag-foreground,#a6a6a6);" +
        "font-family:inherit;font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.4;font-weight:600;padding:6px 10px;" +
        "border-radius:7px;cursor:pointer;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv-tab:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv3-root .zu-sv-tab:hover{background:rgba(0,0,0,.05)}" +
      ".zu-sv3-root .zu-sv-tab.on{background:rgba(255,255,255,.07);color:var(--color-foreground,#e9edf4);" +
        "box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}" +
      ".zu-light .zu-sv3-root .zu-sv-tab.on{background:rgba(0,0,0,.06);color:var(--color-foreground,#1c212b);" +
        "box-shadow:inset 0 0 0 1px rgba(15,23,42,.08)}" +
      ".zu-sv3-root .zu-sv-tab.on:hover{background:rgba(255,255,255,.09)}" +
      ".zu-light .zu-sv3-root .zu-sv-tab.on:hover{background:rgba(0,0,0,.07)}" +
      ".zu-sv3-root .zu-sv-tab:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      /* ---- 筛选条：漏斗+标签 | chips | 计数+搜索 ---- */
      ".zu-sv3-root .zu-sv3-fbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:5px 10px;margin-bottom:10px;" +
        "border:1px solid var(--color-popover-border,rgba(255,255,255,.1));border-radius:9px;background:rgba(255,255,255,.03)}" +
      ".zu-light .zu-sv3-root .zu-sv3-fbar{background:rgba(0,0,0,.03);border-color:rgba(15,23,42,.1)}" +
      ".zu-sv3-root .zu-sv3-fico{display:inline-flex;flex:0 0 auto;opacity:.75;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-sv3-flabel{font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);flex:0 0 auto}" +
      ".zu-sv3-root .zu-sv3-chips{display:flex;flex:1 1 auto;flex-wrap:wrap;gap:4px;min-width:0}" +
      ".zu-sv3-root .zu-sv3-chip{appearance:none;border:1px solid var(--color-popover-border,rgba(255,255,255,.12));" +
        "background:transparent;color:var(--color-tooltip-tag-foreground,#a6a6a6);display:inline-flex;align-items:center;gap:5px;" +
        "font-family:inherit;font-size:calc(var(--ui-font-size,14px) - 3px);line-height:1.3;padding:3px 9px;border-radius:999px;" +
        "cursor:pointer;max-width:170px;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-chip:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.05)}" +
      ".zu-light .zu-sv3-root .zu-sv3-chip:hover{background:rgba(0,0,0,.04)}" +
      ".zu-sv3-root .zu-sv3-chip.on{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.07);" +
        "box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}" +
      ".zu-light .zu-sv3-root .zu-sv3-chip.on{background:rgba(0,0,0,.06);box-shadow:inset 0 0 0 1px rgba(15,23,42,.1)}" +
      ".zu-sv3-root .zu-sv3-chip:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv3-root .zu-sv3-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:0 0 auto}" +
      ".zu-sv3-root .zu-sv3-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-chip-miss{font-style:normal;font-size:calc(var(--ui-font-size,14px) - 4px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);opacity:.85;flex:0 0 auto}" +
      ".zu-sv3-root .zu-sv3-chip-empty{border-style:dashed;opacity:.8}" +
      ".zu-sv3-root .zu-sv3-chip-more{display:inline-flex;align-items:center;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);padding:3px 6px;flex:0 0 auto;font-variant-numeric:tabular-nums}" +
      ".zu-sv3-root .zu-sv3-fcount{margin-left:auto;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);font-variant-numeric:tabular-nums;flex:0 0 auto;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-fsearch{appearance:none;border:1px solid var(--color-popover-border,rgba(255,255,255,.12));" +
        "background:transparent;color:var(--color-tooltip-tag-foreground,#a6a6a6);width:24px;height:24px;border-radius:7px;" +
        "display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;padding:0}" +
      ".zu-sv3-root .zu-sv3-fsearch:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv3-root .zu-sv3-fsearch:hover{background:rgba(0,0,0,.05)}" +
      ".zu-sv3-root .zu-sv3-fsearch svg{width:13px;height:13px}" +
      ".zu-sv3-root .zu-sv3-fsearch:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      /* ---- 主区：左卡 250px 固定 + 右图表自适应（≤760px 视口左卡收 220px） ---- */
      ".zu-sv3-root .zu-sv3-main{display:flex;gap:12px;align-items:stretch;flex:1;min-height:0}" +
      ".zu-sv3-root .zu-sv3-left{flex:0 0 250px;min-width:0;display:flex;flex-direction:column;min-height:0;" +
        "border:1px solid var(--color-popover-border,rgba(255,255,255,.14));border-radius:12px;padding:10px 12px}" +
      ".zu-light .zu-sv3-root .zu-sv3-left{border-color:rgba(15,23,42,.14)}" +
      ".zu-sv3-root .zu-sv3-chart{flex:1 1 0;min-width:0;max-width:100%;display:flex;flex-direction:column;min-height:0;" +
        "border:1px solid var(--color-popover-border,rgba(255,255,255,.14));border-radius:12px;padding:10px 12px}" +
      ".zu-light .zu-sv3-root .zu-sv3-chart{border-color:rgba(15,23,42,.14)}" +
      "@media (max-width:760px){.zu-sv3-root .zu-sv3-left{flex:0 0 220px}}" +
      /* ---- 图表标题栏（.zu-sc-* 基类属 V1 共享，这里只做 V3 作用域覆写） ---- */
      ".zu-sv3-chart .zu-sc-head{margin-left:0;align-items:center;flex-wrap:wrap;row-gap:2px}" +
      ".zu-sv3-chart .zu-sc-title{font-weight:600;font-size:calc(var(--ui-font-size,14px) + 2px);line-height:1.3;" +
        "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-sv3-chart .zu-sc-unit{margin-left:9px;background:rgba(255,255,255,.05);border-radius:5px;padding:2px 7px;" +
        "font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-tag-foreground,#a6a6a6);flex:0 0 auto}" +
      ".zu-light .zu-sv3-chart .zu-sc-unit{background:rgba(0,0,0,.05)}" +
      ".zu-sv3-chart .zu-sv-legend-btn{appearance:none;border:0;background:transparent;" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);width:26px;height:26px;padding:0;margin-left:4px;border-radius:7px;" +
        "display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;align-self:center}" +
      ".zu-sv3-chart .zu-sv-legend-btn svg{width:18px;height:18px}" +
      ".zu-sv3-chart .zu-sv-legend-btn:hover,.zu-sv3-chart .zu-sv-legend-btn:focus-visible{" +
        "color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv3-chart .zu-sv-legend-btn:hover,.zu-light .zu-sv3-chart .zu-sv-legend-btn:focus-visible{" +
        "background:rgba(0,0,0,.05)}" +
      ".zu-sv3-chart .zu-sv-legend-btn:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv3-chart .zu-sc-sub{font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);flex:0 0 auto}" +
      ".zu-sv3-chart .zu-sv-range{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;max-width:60%;margin-left:auto;" +
        "font-variant-numeric:tabular-nums;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);white-space:nowrap}" +
      ".zu-sv3-chart .zu-sv-range svg{width:13px;height:13px;flex:0 0 auto;opacity:.75}" +
      ".zu-sv3-chart .zu-sv-range span{overflow:hidden;text-overflow:ellipsis}" +
      /* ---- 左卡内部 ---- */
      ".zu-sv3-root .zu-sv3-title-row{display:flex;align-items:center;gap:6px;min-width:0}" +
      ".zu-sv3-root .zu-sv3-ltitle{font-weight:600;font-size:calc(var(--ui-font-size,14px) - 1px);" +
        "color:var(--color-foreground,#e9edf4);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-sub{flex:0 0 auto;white-space:nowrap;font-weight:400;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);opacity:.85}" +
      ".zu-sv3-root .zu-sv3-main-num{margin-top:8px;font-variant-numeric:tabular-nums;" +
        "font-size:calc(var(--ui-font-size,14px) + 22px);font-weight:700;line-height:1.1;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-main-num .zu-sv3-unit{font-size:calc(var(--ui-font-size,14px) + 4px);font-weight:600;" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);margin-left:4px}" +
      ".zu-sv3-root .zu-sv3-main-num .dim{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-sv3-band{display:inline-block;margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "border:1px solid var(--color-popover-border,rgba(255,255,255,.16));border-radius:999px;padding:2px 10px;" +
        "white-space:nowrap;align-self:flex-start}" +
      ".zu-light .zu-sv3-root .zu-sv3-band{border-color:rgba(15,23,42,.16)}" +
      ".zu-sv3-root .zu-sv3-model{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;margin-top:8px;" +
        "padding:2px 10px;border:1px solid var(--color-popover-border,rgba(255,255,255,.14));border-radius:999px;" +
        "background:rgba(255,255,255,.03)}" +
      ".zu-light .zu-sv3-root .zu-sv3-model{border-color:rgba(15,23,42,.14);background:rgba(0,0,0,.04)}" +
      ".zu-sv3-root .zu-sv3-only{font-style:normal;font-size:calc(var(--ui-font-size,14px) - 4px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);flex:0 0 auto}" +
      ".zu-sv3-root .zu-sv3-count{display:flex;align-items:center;gap:6px;margin-top:8px;min-width:0;" +
        "font-size:calc(var(--ui-font-size,14px) - 1px);font-weight:600}" +
      ".zu-sv3-root .zu-sv3-count svg{flex:0 0 auto;opacity:.85}" +
      ".zu-sv3-root .zu-sv3-kv{display:flex;align-items:baseline;justify-content:space-between;gap:8px;" +
        "font-size:calc(var(--ui-font-size,14px) - 2px);margin-top:6px;min-width:0}" +
      ".zu-sv3-root .zu-sv3-kv i{font-style:normal;color:var(--color-tooltip-tag-foreground,#a6a6a6);flex:0 0 auto}" +
      ".zu-sv3-root .zu-sv3-kv b{font-weight:600;font-variant-numeric:tabular-nums;min-width:0;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;text-align:right}" +
      /* v384 M4：覆盖范围改单值 kv（.zu-sv3-kv 承载），五值结构 CSS 删除 */
      ".zu-sv3-root .zu-sv3-cov-h{font-style:normal;color:var(--color-tooltip-tag-foreground,#a6a6a6);display:block;margin-top:10px}" +
      ".zu-sv3-root .zu-sv3-dist-h{margin-top:10px;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-sv3-dbar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:6px;" +
        "background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv3-root .zu-sv3-dbar{background:rgba(0,0,0,.06)}" +
      ".zu-sv3-root .zu-sv3-dbar i{display:block;height:100%}" +
      ".zu-sv3-root .zu-sv3-dtab{width:100%;border-collapse:collapse;margin-top:6px;" +
        "font-size:calc(var(--ui-font-size,14px) - 3px);font-variant-numeric:tabular-nums}" +
      ".zu-sv3-root .zu-sv3-dtab th{font-weight:400;color:var(--color-tooltip-tag-foreground,#a6a6a6);text-align:left;padding:2px 0}" +
      ".zu-sv3-root .zu-sv3-dtab td{padding:3px 0;color:var(--color-foreground,#e9edf4);min-width:0}" +
      ".zu-sv3-root .zu-sv3-dtab th:nth-child(n+2),.zu-sv3-root .zu-sv3-dtab td:nth-child(n+2){text-align:right;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-dtab .zu-sv3-dmodel{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:150px}" +
      ".zu-sv3-root .zu-sv3-dtab .zu-sv3-dmodel .zu-sv3-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-more{appearance:none;border:0;background:transparent;color:var(--color-brand,#a3cfff);" +
        "font-family:inherit;font-size:calc(var(--ui-font-size,14px) - 3px);padding:4px 0 0;margin:0;cursor:pointer;text-align:left}" +
      ".zu-sv3-root .zu-sv3-more:hover{text-decoration:underline}" +
      ".zu-sv3-root .zu-sv3-more:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv3-root .zu-sv3-stats{display:flex;gap:10px;margin-top:auto;padding-top:12px}" +
      ".zu-sv3-root .zu-sv3-stat{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px}" +
      ".zu-sv3-root .zu-sv3-stat i{font-style:normal;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-sv3-stat b{font-weight:600;font-variant-numeric:tabular-nums;" +
        "font-size:calc(var(--ui-font-size,14px) + 2px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-sv3-root .zu-sv3-notice{margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* ---- 筛选弹出层：absolute 于卡内右下 ---- */
      ".zu-sv3-root .zu-sv3-fpop{position:absolute;right:10px;bottom:10px;z-index:6;width:280px;max-width:calc(100% - 20px);" +
        "max-height:320px;display:flex;flex-direction:column;padding:8px;border-radius:10px;" +
        "border:1px solid var(--color-popover-border,rgba(255,255,255,.16));background:var(--color-popover,#1c212b);" +
        "box-shadow:0 8px 28px rgba(0,0,0,.35)}" +
      ".zu-light .zu-sv3-root .zu-sv3-fpop{background:var(--color-popover,#ffffff);border-color:rgba(15,23,42,.16);" +
        "box-shadow:0 8px 28px rgba(15,23,42,.18)}" +
      ".zu-sv3-root .zu-sv3-fpop-input{width:100%;appearance:none;border:1px solid var(--color-popover-border,rgba(255,255,255,.16));" +
        "background:rgba(255,255,255,.05);color:var(--color-foreground,#e9edf4);font-family:inherit;" +
        "font-size:calc(var(--ui-font-size,14px) - 2px);border-radius:7px;padding:5px 8px;flex:0 0 auto}" +
      ".zu-light .zu-sv3-root .zu-sv3-fpop-input{background:rgba(0,0,0,.04)}" +
      ".zu-sv3-root .zu-sv3-fpop-input:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv3-root .zu-sv3-fpop-list{overflow-y:auto;margin-top:6px;min-height:0}" +
      ".zu-sv3-root .zu-sv3-fpop-row{display:flex;align-items:center;gap:6px;width:100%;appearance:none;border:0;" +
        "background:transparent;color:var(--color-foreground,#e9edf4);font-family:inherit;" +
        "font-size:calc(var(--ui-font-size,14px) - 3px);padding:4px 6px;border-radius:6px;cursor:pointer;text-align:left}" +
      ".zu-sv3-root .zu-sv3-fpop-row:hover{background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv3-root .zu-sv3-fpop-row:hover{background:rgba(0,0,0,.05)}" +
      ".zu-sv3-root .zu-sv3-fpop-row.on{background:rgba(255,255,255,.08)}" +
      ".zu-light .zu-sv3-root .zu-sv3-fpop-row.on{background:rgba(0,0,0,.07)}" +
      ".zu-sv3-root .zu-sv3-fpop-row:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv3-root .zu-sv3-fpop-row .zu-sv3-chip-name{flex:1 1 auto}" +
      ".zu-sv3-root .zu-sv3-fpop-n{color:var(--color-tooltip-tag-foreground,#a6a6a6);font-variant-numeric:tabular-nums;flex:0 0 auto}" +
      ".zu-sv3-root .zu-sv3-fpop-cap{margin-top:4px;font-size:calc(var(--ui-font-size,14px) - 4px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-sv3-fpop-acts{display:flex;gap:6px;margin-top:6px;padding-top:6px;flex:0 0 auto;" +
        "border-top:1px solid var(--color-popover-border,rgba(255,255,255,.1))}" +
      ".zu-sv3-root .zu-sv3-fpop-btn{flex:1 1 0;appearance:none;border:1px solid var(--color-popover-border,rgba(255,255,255,.12));" +
        "background:transparent;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-family:inherit;" +
        "font-size:calc(var(--ui-font-size,14px) - 3px);padding:4px 0;border-radius:7px;cursor:pointer;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-fpop-btn:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv3-root .zu-sv3-fpop-btn:hover{background:rgba(0,0,0,.05)}" +
      ".zu-sv3-root .zu-sv3-fpop-btn:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      /* v384 B1：V2 的 :has 定宽释放规则随 V2 块删除——V3 卡 920 基准必须压过 .tip 基类
       * 560 帽与 tpsTip 内联 520 帽，否则整卡被 tip 宽度裁剪（红队 BLOCKER） */
      ".tip:has(.zu-sv3-root),.zusage-tps-tip:has(.zu-sv3-root){width:min(920px,calc(100vw - 24px))!important;" +
        "max-width:min(920px,calc(100vw - 24px))!important}" +
      "</style>";
  }
  /* ==================== ⑧ chips 池与整卡装配 ====================
   * chips 池缺省 = an.perModel（out 降序）+ an.selMissing 兜底补枚；筛选激活时集成方
   * 传 ctx.pool（未筛选全量模型）覆盖，保证被筛掉模型仍可从 chips/弹出层点回。
   * 弹出层随 ctx.pop={open,query} 整卡携带（absolute 定位，交互委托由集成方接管）。 */
  function spd3ChipPool(an, ctx) {
    var src = ctx && ctx.pool ? ctx.pool : ((an && an.perModel) || []);
    var seen = {}, pool = [];
    for (var i = 0; i < src.length; i++) {
      var e = src[i], key = spd3ModelKey(e);
      if (seen[key]) continue;
      seen[key] = true;
      pool.push({ key: key, name: e.name || spd3KeyName(key), n: spdNum(e.n) });
    }
    var miss = (an && an.selMissing) || [];
    for (var j = 0; j < miss.length; j++) if (!seen[miss[j]]) {
      seen[miss[j]] = true;
      pool.push({ key: miss[j], name: spd3KeyName(miss[j]), n: 0, missing: true });
    }
    return pool;
  }
  function spd3CardHTML(an, ctx) {
    if (!an) return "";
    ctx = ctx || {};
    var sel = ctx.sel || {};
    var filt = sel.filt || null;
    var key = spdEsc((an.range || "") + "|" + (an.period || "") + "|" + spd3FilterSig(filt));
    var pool = spd3ChipPool(an, ctx);
    var notice = spd3NoticeHTML(an);
    var pop = ctx.pop && ctx.pop.open ? spd3FilterPopHTML(pool, filt, ctx.pop.query) : "";
    return '<div class="zu-sv3-root" data-sv-key="' + key + '">' + spd3StylesHTML() +
      spd3HeadHTML(an) +
      spd3FilterBarHTML(pool, filt, { selMissing: an.selMissing, pop: ctx.pop }) +
      '<div class="zu-sv3-main">' + spd3LeftHTML(an, ctx.live, !!ctx.expanded) +
      '<div class="zu-speed-chart zu-sv3-chart" data-sv3-chart><!--CHART--></div></div>' +
      (notice ? '<div class="zu-sv3-notice">' + spdEsc(notice) + "</div>" : "") +
      pop + "</div>";
  }
  /* SPD_V3_VIEW_END */
