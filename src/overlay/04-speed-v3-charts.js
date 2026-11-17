  /* ---------- v384 生成速度 Tooltip V3：图表分片（近/今/近7天三形态 + 悬停卡，纯字符串） ----------
   * spec §5 三图表形态 + §2 模型色 + §7 悬停卡契约。本分片只做字符串拼装（零 DOM），
   * 唯一副作用是给模块外变量 SPD_PORTAL 赋值（02 分片声明的悬停卡侧信道，宿主
   * spdHoverPortalSync 既有机制消费即清）：每次构建先置空串，有悬停才写卡串。
   * 数据上游 = 04-speed-v3-core.js 的 spd3Analyze 产物 an（结果只读，绝不原地改）；
   * 图表头 spd3ChartHeadHTML(an, sub) 由 view 分片提供（V3 集成后同 IIFE 可达）。
   * 只引用存活符号：L / SPD_L / TPS_BANDS / tpsBand / spdEsc / spdNum / spdFull /
   * spdLabel / spdCompactRange + core 的 spd3Color / spd3ModelKey。V2 专属函数
   * （spdChartHTML/spdCardHTML/spdChartLayout 等）一律不引用：Y 轴整洁刻度阶梯在本
   * 文件实现 spd3Ticks（算法与 V2 同构：1/2/2.5/5/6/7.5×10^k，同档先 ×4 后 ×5，
   * need ≥ maxV×1.12）。month/all 热力形态归 heat 分片，本函数对未知 period 返回
   * 空串（错接线显性暴露，不静默画错图）。样式全部 .zu-sv3- 前缀并集中在常量
   * SPD3_CHART_CSS（只在 recent/today/week 三分支产物头部出现一次；.zu-sc-* 基础
   * 类沿用宿主 06 分片静态样式，这里只做 V3 作用域覆写）。本文件可独立
   * node --check、可单独切片进 VM 夹具。 */
  /* SPD_V3_CHARTS_BEGIN */
  /* ==================== ① 几何常量与 Y 轴整洁刻度 ====================
   * 几何纪律（.zcode/rules/overlay-ui.md §5）：柱区/绘图区固定 px 不随 --ui-font-size，
   * 读数一位小数，X 轴每柱恒显时分，多桶横滚兜底。 */
  var SPD3_PLOT_H = 148;   /* 柱区 / 折线绘图区固定高（px） */
  var SPD3_X_H = 16;       /* X 轴标签带高（px） */
  var SPD3_GUT_W = 30;     /* Y 轴刻度列宽（px，= 柱图 plot 左缩进） */
  var SPD3_PITCH = 24;     /* 柱距 / 命中列宽（px，柱 14 + 10 间距） */
  var SPD3_BAR_W = 14;     /* 柱宽（px） */
  /* Y 轴整洁刻度阶梯（V2 算法复刻）：need ≥ maxV×1.12，同档先 ×4 后 ×5；
   * maxV=0 退化为 {yMax:4, step:1}（调用方在无有效数据时走空态，不会用它画图）。 */
  function spd3Ticks(maxV) {
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
    return { yMax: yMax, step: step, ticks: ticks };
  }
  /* ==================== ② 图表样式（.zu-sv3- 前缀，集中声明一次） ====================
   * 选择器统一挂 .zu-sv3-chart 作用域（0,2,0 特异性稳定压过 06 分片的 .zu-sc-* 基础
   * 规则，不依赖样式表注入顺序）；V2 专属类（zu-sv-bars/zu-sv-plot 等）随 V2 删除，
   * 柱组容器/几何在本表自带，不依赖其存留。 */
  var SPD3_CHART_CSS = "<style>" +
    /* 容器与滚动 */
    ".zu-sv3-chart{display:flex;flex-direction:column;min-height:0}" +
    ".zu-sv3-chart .zu-sv-empty{flex:1;min-height:120px}" +
    ".zu-sv3-chart .zu-sc-wrap{flex:1;min-height:0;padding:5px 0;box-sizing:border-box;overflow-x:auto;overflow-y:hidden;width:100%}" +
    /* 柱图 plot 定高 164 = 柱区 148 + X 轴 16；max-content 由 in-flow spacer 撑宽 */
    ".zu-sv3-chart .zu-sc-plot{height:" + (SPD3_PLOT_H + SPD3_X_H) + "px;min-width:max(240px,100%);width:max-content;max-width:none;box-sizing:content-box}" +
    ".zu-sv3-chart .zu-sc-grid,.zu-sv3-chart .zu-sc-gutter{height:" + SPD3_PLOT_H + "px}" +
    ".zu-sv3-spacer{display:block;height:0}" +
    /* 柱组：定宽柱距、贴 Y 轴左对齐（v308 纪律）、两侧 5px 呼吸边距（柱顶 nowrap
     * 数值越缘不撑出横滚）；多柱（n≥10）spread 均匀铺满 */
    ".zu-sv3-bars{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:flex-start;gap:0;padding:0 5px}" +
    ".zu-sv3-bars--spread{justify-content:space-between}" +
    ".zu-sv3-bars .zu-sc-col{flex:0 0 " + SPD3_PITCH + "px;height:100%}" +
    ".zu-sv3-bars .zu-sc-vz{flex:0 0 " + SPD3_PLOT_H + "px;height:" + SPD3_PLOT_H + "px}" +
    ".zu-sv3-bars .zu-sc-bar{width:" + SPD3_BAR_W + "px;max-width:" + SPD3_BAR_W + "px}" +
    ".zu-sv3-bars .zu-sc-x{height:" + SPD3_X_H + "px;flex:0 0 " + SPD3_X_H + "px;width:" + SPD3_PITCH + "px;max-width:" + SPD3_PITCH + "px;overflow:visible;justify-content:flex-start;align-items:flex-end;font-size:7px}" +
    ".zu-sv3-bars .zu-sc-x b{display:block;width:100%;overflow:hidden;text-overflow:clip;text-align:center;line-height:14px}" +
    ".zu-sv3-bars .zu-sc-col.empty .zu-sc-bar{background:transparent;box-shadow:none}" +
    ".zu-sv3-bars .zu-sc-col.cur .zu-sc-val{font-weight:700}" +
    ".zu-sv3-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px var(--color-popover-border,rgba(255,255,255,.28))}" +
    ".zu-light .zu-sv3-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px rgba(15,23,42,.22)}" +
    /* 混合轮中性灰（spec §5：不得用主导模型色填满混合轮） */
    ".zu-sv3-chart .zu-sc-bar.zu-sv3-mix{background:var(--color-tooltip-tag-foreground,#8a8f98)}" +
    /* SVG 折线（今天多模型 / 近 7 天） */
    ".zu-sv3-svg{display:block}" +
    ".zu-sv3-gline{stroke:var(--color-border,rgba(255,255,255,.1));stroke-dasharray:3 3}" +
    ".zu-sv3-gline[data-base]{stroke:var(--color-border,rgba(255,255,255,.16));stroke-dasharray:none}" +
    ".zu-sv3-gtxt{fill:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:9px;font-variant-numeric:tabular-nums}" +
    ".zu-sv3-xtxt{fill:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:8px;text-anchor:middle;font-variant-numeric:tabular-nums}" +
    ".zu-sv3-line{fill:none;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}" +
    ".zu-sv3-nline{stroke:var(--color-tooltip-tag-foreground,#8a8f98)}" +
    ".zu-sv3-area{stroke:none;fill-opacity:.12}" +
    ".zu-sv3-chart .zu-sc-wrap::-webkit-scrollbar{display:none}" +
    ".zu-sv3-oline{fill:none;stroke:var(--color-tooltip-tag-foreground,#8a8f98);stroke-width:1.4;stroke-dasharray:4 3}" +
    ".zu-sv3-pt{stroke:none}" +
    ".zu-sv3-npt{fill:var(--color-tooltip-tag-foreground,#8a8f98)}" +
    ".zu-sv3-elabel{font-size:9.5px;font-weight:600;font-variant-numeric:tabular-nums;text-anchor:end;fill:var(--color-foreground,#e9edf4)}" +
    ".zu-sv3-elabel.zu-sv3-olabel{fill:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:400}" +
    /* 悬停命中列与十字参考线（hover/focus 纯 CSS 显现，零 JS 监听） */
    ".zu-sv3-hit{fill:#000;fill-opacity:0;pointer-events:all;outline:none}" +
    ".zu-sv3-hit:focus-visible{stroke:var(--color-brand,#a3cfff);stroke-width:1.5}" +
    ".zu-sv3-xline{stroke:var(--color-border,rgba(255,255,255,.3));stroke-dasharray:3 3;opacity:0;pointer-events:none}" +
    ".zu-sv3-hg:hover .zu-sv3-xline,.zu-sv3-hg:focus-within .zu-sv3-xline{opacity:1}" +
    /* 悬停卡模型组成行（卡根 .zu-sv-card 基础样式由 06 分片提供） */
    ".zu-sv3-msub>b{overflow:hidden}" +
    ".zu-sv3-mi{display:flex;align-items:center;justify-content:flex-end;gap:5px;min-width:0;font-weight:400}" +
    ".zu-sv3-mdot{display:inline-block;width:8px;height:8px;border-radius:2px;flex:0 0 8px}" +
    ".zu-sv3-mname{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".zu-sv3-mv{font-style:normal;font-variant-numeric:tabular-nums;font-weight:600;flex:0 0 auto}" +
    ".zu-sv3-mt{font-style:normal;font-variant-numeric:tabular-nums;font-weight:400;opacity:.65;flex:0 0 auto}" +
    "</style>";
  /* ==================== ③ 通用小件 ==================== */
  function spd3RealMax(items) {
    var maxV = 0;
    for (var i = 0; i < items.length; i++) if (!items[i].empty && items[i].v > maxV) maxV = items[i].v;
    return maxV;
  }
  /* 柱图网格线 + Y 轴刻度标签（V2 几何同款：0 基线加粗、顶刻度钉在 100%-13px） */
  function spd3GridTicks(tk) {
    var grid = "", gutter = "";
    for (var g = 0; g < tk.ticks.length; g++) {
      var pct = Math.round(tk.ticks[g] / tk.yMax * 1000) / 10;
      grid += '<i style="bottom:' + pct + '%"' + (tk.ticks[g] ? "" : ' data-base="1"') + "></i>";
      gutter += '<i' + (g === tk.ticks.length - 1 ? ' class="top" style="bottom:calc(100% - 13px)"' : ' style="bottom:' + pct + '%"') + ">" + tk.ticks[g] + "</i>";
    }
    return { grid: grid, gutter: gutter };
  }
  /* 悬停卡侧信道：有悬停且目标桶非空才写卡（空桶/未悬停 = 空串 = Portal 收起） */
  function spd3PortalFor(items, hoverIdx, o) {
    return (hoverIdx >= 0 && items[hoverIdx] && !items[hoverIdx].empty)
      ? spd3HoverCardHTML(items[hoverIdx], o, hoverIdx) : "";
  }
  /* ==================== ④ 柱状图列构建（recent / 今天单模型共用） ====================
   * 柱色规则（spec §5）：行 models.length===1 → 柱色=spd3Color(模型key)（内联
   * background，速度档位色阶不再上柱体）；>1 → .zu-sv3-mix 中性灰（绝不用主导模型
   * 色）+ title/aria 标「混合」；=0（旧帧无 msl）→ 中性默认色（基础 currentColor）。
   * 柱顶读数一位小数，n>8 按 valEvery=ceil(n/8) 抽稀（首/末/悬停恒显，空桶不显）；
   * X 轴每柱恒显时分；最新柱（最右）latest 描边。 */
  function spd3BarCols(items, hoverIdx, yMax) {
    var n = items.length, valEvery = Math.max(1, Math.ceil(n / 8)), cols = "";
    for (var c = 0; c < n; c++) {
      var it = items[c], isCur = c === hoverIdx, empty = !!it.empty;
      var mcolor = "", mix = false, mname = "";
      if (!empty && it.models && it.models.length) {
        if (it.models.length === 1) { mcolor = spd3Color(spd3ModelKey(it.models[0])); mname = it.models[0].name || ""; }
        else mix = true;
      }
      var vv = spdNum(it.v);
      var hPct = empty || !(vv > 0) ? 0 : Math.max(1.2, Math.round(vv / yMax * 1000) / 10);
      var shown = !empty && (isCur || n <= 8 || c === n - 1 || c === 0 || c % valEvery === 0);
      var aria = it.label + SPD_L("，", ", ") + (empty || !(vv > 0) ? SPD_L("无数据", "no data") : (vv.toFixed(1) + " t/s")) +
        (mname ? SPD_L("，", ", ") + mname : "") + (mix ? SPD_L("，", ", ") + SPD_L("混合", "mixed") : "");
      cols += '<div class="zu-sc-col' + (isCur ? " cur" : "") + (empty ? " empty" : "") +
        (c === n - 1 ? " latest" : "") +
        '" role="img" tabindex="0" data-i="' + c + '"' +
        (mix ? ' title="' + spdEsc(SPD_L("混合（" + it.models.length + " 种模型）", "Mixed (" + it.models.length + " models)")) + '"' : "") +
        ' aria-label="' + spdEsc(aria) + '">' +
        '<span class="zu-sc-vz"><span class="zu-sc-val">' + (shown ? vv.toFixed(1) : "") + "</span>" +
        '<i class="zu-sc-bar' + (mix ? " zu-sv3-mix" : "") + '" style="height:' + hPct + "%" +
        (mcolor ? ";background:" + mcolor : "") + '"></i></span>' +
        '<span class="zu-sc-x"><b>' + spdEsc(it.label) + "</b></span></div>";
    }
    return cols;
  }
  /* ==================== ⑤ 悬停卡（五字段 + 真实模型组成） ====================
   * 结构沿 V2 spdCardHTML 纪律：时间（tv 覆写保留，缺省聚合桶区间压缩）/ 速度（档位
   * 色值）/ 模型型号 / Token 总消耗（input 已含缓存、output 已含思考，不重复相加）/
   * 预估价格（缺失显暂无估价，绝不显示 0）。「模型型号」段升级（spec §7）：多模型
   * 主行标「混合（N 种模型）」+ 逐模型子行（色点 + 名 + 该模型 t/s + 该模型 token）；
   * t/s 仅在该模型条目 ms>0 时给出（绝不拿整轮窗口冒充模型速度），无 ms 只显名称与
   * token。o={fmtTok,fmtCnt,fmtMoney}，fmtMoney 缺失按 V2 纪律显「费用显示已关闭」。
   * hoverIdx 可选：≥0 时卡根携带 data-i（Portal 定位与键盘焦点归位消费）。 */
  function spd3HoverCardHTML(item, o, hoverIdx) {
    if (!item || item.empty || !(spdNum(item.v) > 0)) return "";
    var bd = tpsBand(item.v), vv = spdNum(item.v);
    var cls = "zu-sv-card" + (bd ? " " + bd.cls : "");
    var ms = item.models || [], mix = ms.length > 1;
    var modelFull, modelCell;
    if (!ms.length) {
      modelFull = SPD_L("未知模型", "Unknown model");
      modelCell = '<b class="zu-model-fit">' + spdEsc(modelFull) + "</b>";
    } else if (mix) {
      modelFull = ms.map(function (m) { return m.name; }).join(", ");
      modelCell = '<b class="zu-model-fit" title="' + spdEsc(modelFull) + '">' +
        spdEsc(SPD_L("混合（" + ms.length + " 种模型）", "Mixed (" + ms.length + " models)")) + "</b>";
    } else {
      modelFull = ms[0].name || "";
      modelCell = '<b class="zu-model-fit zu-sv3-mi" title="' + spdEsc(modelFull) + '">' +
        '<i class="zu-sv3-mdot" style="background:' + spd3Color(spd3ModelKey(ms[0])) + '"></i>' +
        '<span class="zu-sv3-mname">' + spdEsc(modelFull) + "</span></b>";
    }
    var fmtTok = o && typeof o.fmtTok === "function" ? o.fmtTok : null;
    var tok = spdNum(item.i) + spdNum(item.o);
    var tokLine = (fmtTok ? fmtTok(tok) : String(tok)) + SPD_L(" token", " tokens");
    var sub = SPD_L("（输入 ", " (in ") + (fmtTok ? fmtTok(spdNum(item.i)) : String(spdNum(item.i))) +
      SPD_L(" · 输出 ", " · out ") + (fmtTok ? fmtTok(spdNum(item.o)) : String(spdNum(item.o))) + SPD_L("）", ")");
    var cost;
    if (!o || !o.fmtMoney) cost = '<span class="zu-sv-off">' + spdEsc(SPD_L("费用显示已关闭", "Cost display off")) + "</span>";
    else if (item.c === null || item.c === undefined) cost = '<span class="zu-sv-off">' + spdEsc(SPD_L("暂无估价", "Estimate unavailable")) + "</span>";
    else cost = spdEsc(o.fmtMoney(item.c)) + (!item.costFull ? '<i class="zu-sv-partial">' + spdEsc(SPD_L(" · 含兜底估价", " · partly estimated")) + "</i>" : "");
    var rows = '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("时间", "Time")) +
      '</span><b class="zu-sv-twrap" title="' + spdEsc(item.full || "") + '">' +
      spdEsc(item.tv || spdCompactRange(item.a, item.b)) + "</b></div>" +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("速度", "Speed")) + '</span><b class="zu-sv-cval' +
      (bd ? " " + bd.cls : "") + '">' + (vv % 1 ? vv.toFixed(1) : String(vv)) + " t/s</b></div>" +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("模型型号", "Model")) + "</span>" + modelCell + "</div>";
    for (var j = 0; mix && j < ms.length; j++) {
      var m = ms[j], mtps = spdNum(m.ms) > 0
        ? '<i class="zu-sv3-mv">' + (m.o / (m.ms / 1000)).toFixed(1) + " t/s</i>" : "";
      rows += '<div class="zu-sv-crow zu-sv3-msub"><span></span><b class="zu-sv3-mi">' +
        '<i class="zu-sv3-mdot" style="background:' + spd3Color(spd3ModelKey(m)) + '"></i>' +
        '<span class="zu-sv3-mname" title="' + spdEsc(m.name) + '">' + spdEsc(m.name) + "</span>" + mtps +
        '<i class="zu-sv3-mt">' + spdEsc((fmtTok ? fmtTok(spdNum(m.o)) : String(spdNum(m.o))) + SPD_L(" token", " tokens")) + "</i></b></div>";
    }
    rows += '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("Token 总消耗", "Total tokens")) + '</span><b>' + spdEsc(tokLine) +
      '<small>' + spdEsc(sub) + "</small></b></div>" +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("预估价格", "Est. cost")) + "</span><b>" + cost + "</b></div>";
    return '<div class="' + cls + '" role="tooltip"' +
      (typeof hoverIdx === "number" && hoverIdx >= 0 ? ' data-i="' + hoverIdx + '"' : "") + ">" + rows + "</div>";
  }
  /* ==================== ⑥ 空态 ==================== */
  function spd3ChartEmptyHTML(head) {
    return '<div class="zu-speed-chart zu-sv3-chart">' + (head || "") +
      '<div class="zu-sv-empty">' + spdEsc(SPD_L("当前筛选无有效速度数据", "No rated turns for this filter")) +
      '<span class="zu-sv-empty-hint">' + spdEsc(SPD_L("尝试选择更长时间范围", "Try a longer time range")) + "</span></div></div>";
  }
  /* ==================== ⑦ recent：一轮一柱（柱色=模型身份） ==================== */
  function spd3RecentHTML(an, hoverIdx, o) {
    var items = an.items, n = items.length;
    var head = spd3ChartHeadHTML(an, "") || "";
    var maxV = spd3RealMax(items);
    if (!n || !(maxV > 0)) return spd3ChartEmptyHTML(head);
    var tk = spd3Ticks(maxV), gt = spd3GridTicks(tk);
    SPD_PORTAL = spd3PortalFor(items, hoverIdx, o);
    return SPD3_CHART_CSS +
      '<div class="zu-speed-chart zu-sv3-chart">' + head +
      '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu-sc-plot">' +
      '<i class="zu-sv3-spacer" style="width:' + Math.max(240, n * SPD3_PITCH + 12) + 'px"></i>' +
      '<span class="zu-sc-grid">' + gt.grid + '</span>' +
      '<span class="zu-sc-gutter">' + gt.gutter + '</span>' +
      '<span class="zu-sv3-bars' + (n >= 10 ? " zu-sv3-bars--spread" : "") + '">' +
      spd3BarCols(items, hoverIdx, tk.yMax) + "</span></div></div></div>";
  }
  /* ==================== ⑧ today：小时桶（单模型柱 / 多模型折线） ====================
   * 单模型判定：筛选后池内 distinct 模型 key 数===1（an.perModel）。单模型（含旧帧
   * 降级）恒柱状：桶整值 = 该模型口径（无窗口帧按 spec §6 画整轮值，同样诚实）；
   * 多模型折线从 an.items[].models 取每模型分量（ms>0 才有点），降级多模型
   * （msAvail=false，逐模型无速度可画）退化为一条中性整轮值线。 */
  function spd3TodayHTML(an, hoverIdx, o) {
    var items = an.items, n = items.length;
    var head = spd3ChartHeadHTML(an, "") || "";
    var maxV = spd3RealMax(items);
    if (!n || !(maxV > 0)) return spd3ChartEmptyHTML(head);
    if (an.perModel && an.perModel.length === 1) {
      var tk = spd3Ticks(maxV), gt = spd3GridTicks(tk);
      SPD_PORTAL = spd3PortalFor(items, hoverIdx, o);
      return SPD3_CHART_CSS +
        '<div class="zu-speed-chart zu-sv3-chart">' + head +
        '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu-sc-plot">' +
        '<i class="zu-sv3-spacer" style="width:' + Math.max(240, n * SPD3_PITCH + 12) + 'px"></i>' +
        '<span class="zu-sc-grid">' + gt.grid + '</span>' +
        '<span class="zu-sc-gutter">' + gt.gutter + '</span>' +
        '<span class="zu-sv3-bars' + (n >= 10 ? " zu-sv3-bars--spread" : "") + '">' +
        spd3BarCols(items, hoverIdx, tk.yMax) + "</span></div></div></div>";
    }
    return spd3LineHTML(an, hoverIdx, o, items, head, false);
  }
  /* ==================== ⑨ 折线图共用（今天多模型 / 近 7 天） ====================
   * 每系列一条 path（颜色=spd3Color，缺数据断线不插值：连续非空点一段 M…L…）；
   * 数据点 circle r=2.5 只落在真实点；命中列 rect（data-i=桶序号）承载悬停/键盘，
   * 同组内竖线十字参考线由 CSS :hover/:focus-within 显现。weekForm=近 7 天形态：
   * 附加末端数值标签（末端 y 冲突时上下错开 ≥12px）与中性虚线「总体」——spec §5
   * 的总体线是 week 多模型专属，今天多模型只有逐模型线 + 悬停十字卡。 */
  function spd3SeriesPts(slots, key) {
    var pts = [];
    for (var i = 0; i < slots.length; i++) {
      var it = slots[i], pv = null;
      if (it && !it.empty && it.models && it.models.length) {
        if (key == null) pv = spdNum(it.v) > 0 ? spdNum(it.v) : null;
        else for (var j = 0; j < it.models.length; j++) {
          if (spd3ModelKey(it.models[j]) === key) {
            var mm = it.models[j];
            pv = spdNum(mm.ms) > 0 && spdNum(mm.o) > 0 ? mm.o / (mm.ms / 1000) : null;
            break;
          }
        }
      }
      pts.push(pv);
    }
    return pts;
  }
  /* 命中列 aria：单模型显桶速度，多模型逐模型「名 v t/s」（无窗口如实标注） */
  function spd3HitAria(an, it) {
    var t = (it && it.label) || "";
    if (!it || it.empty || !(spdNum(it.v) > 0)) return t + SPD_L("，", ", ") + SPD_L("无数据", "no data");
    if (an.perModel && an.perModel.length > 1 && an.msAvail && it.models && it.models.length) {
      var parts = [];
      for (var j = 0; j < it.models.length; j++) {
        var m = it.models[j];
        parts.push((m.name || "") + " " + (spdNum(m.ms) > 0
          ? (m.o / (m.ms / 1000)).toFixed(1) + " t/s" : SPD_L("无窗口", "no timing")));
      }
      return t + SPD_L("，", ", ") + parts.join(SPD_L("、", ", "));
    }
    return t + SPD_L("，", ", ") + spdNum(it.v).toFixed(1) + " t/s";
  }
  function spd3LineHTML(an, hoverIdx, o, slots, head, weekForm) {
    var N = slots.length;
    var TOP = 8, PLOT = SPD3_PLOT_H, XH = SPD3_X_H, GX = SPD3_GUT_W + 4, PITCH = SPD3_PITCH, GR = 10;
    /* 少桶（focus 后今天常 1–3 桶）放宽列距，图表本体不缩成窄条 */
    var P = Math.max(PITCH, Math.floor(256 / Math.max(N, 1)));
    var W = GX + N * P + GR, H = TOP + PLOT + XH, base = TOP + PLOT;
    var cx = function (i) { return GX + i * P + P / 2; };
    /* 系列组装：多模型（msAvail）=逐模型线 + 总体虚线（an.overall 在场才画）；
     * 其余（单模型 / 降级多模型）=一条桶整值线（单模型上模型色，降级中性灰） */
    var series = [];
    var multi = an.perModel && an.perModel.length > 1;
    if (multi && an.msAvail) {
      for (var s = 0; s < an.perModel.length; s++) {
        var pm = an.perModel[s];
        series.push({ color: spd3Color(pm.key), dashed: false, pts: spd3SeriesPts(slots, pm.key) });
      }
      if (weekForm && an.overall) series.push({ color: "", dashed: true, pts: spd3SeriesPts(slots, null) });
    } else {
      var solo = !multi && an.perModel && an.perModel.length === 1 ? spd3Color(an.perModel[0].key) : "";
      series.push({ color: solo, dashed: false, pts: spd3SeriesPts(slots, null) });
    }
    var maxV = 0;
    for (var m2 = 0; m2 < series.length; m2++) {
      var pp = series[m2].pts;
      for (var q = 0; q < pp.length; q++) if (pp[q] != null && pp[q] > maxV) maxV = pp[q];
    }
    if (!(maxV > 0)) return spd3ChartEmptyHTML(head);
    var tk = spd3Ticks(maxV);
    var yOf = function (v) { return TOP + (1 - v / tk.yMax) * PLOT; };
    var r1 = function (x) { return Math.round(x * 10) / 10; };
    var grid = "", xtxt = "", body = "", labels = [];
    for (var g = 0; g < tk.ticks.length; g++) {
      var ty = r1(yOf(tk.ticks[g]));
      grid += '<line class="zu-sv3-gline"' + (tk.ticks[g] ? "" : ' data-base="1"') +
        ' x1="' + GX + '" x2="' + (W - GR) + '" y1="' + ty + '" y2="' + ty + '"/>' +
        '<text class="zu-sv3-gtxt" x="' + (GX - 6) + '" y="' + r1(ty + 3) + '" text-anchor="end">' + tk.ticks[g] + "</text>";
    }
    for (var xi = 0; xi < N; xi++) {
      xtxt += '<text class="zu-sv3-xtxt" x="' + r1(cx(xi)) + '" y="' + (base + 11) + '">' +
        spdEsc((slots[xi] && slots[xi].label) || "") + "</text>";
    }
    for (var si = 0; si < series.length; si++) {
      var srs = series[si], d = "", seg = false;
      for (var i3 = 0; i3 < srs.pts.length; i3++) {
        if (srs.pts[i3] == null) { seg = false; continue; }
        d += (seg ? " L " : " M ") + r1(cx(i3)) + " " + r1(yOf(srs.pts[i3]));
        seg = true;
      }
      if (d) body += '<path class="zu-sv3-line' + (srs.color ? "" : " zu-sv3-nline") +
        (srs.dashed ? " zu-sv3-oline" : "") + '"' + (srs.color ? ' stroke="' + srs.color + '"' : "") +
        ' d="' + d + '"/>';
      /* 近 7 天单模型实线：分段面积（模型色 12% 透明度，缺口不填充） */
      /* v384 S6-MINOR5：多模型周视图纯折线+虚线总体（设计稿无面积；单模型保留） */
      if (weekForm && !srs.dashed && srs.color && !(an.perModel && an.perModel.length > 1)) {
        var area = "", seg2 = false, segStart = 0;
        for (var i4 = 0; i4 <= srs.pts.length; i4++) {
          var pv2 = i4 < srs.pts.length ? srs.pts[i4] : null;
          if (pv2 == null) {
            if (seg2) {
              area += " L " + r1(cx(i4 - 1)) + " " + base + " L " + r1(cx(segStart)) + " " + base + " Z";
              seg2 = false;
            }
            continue;
          }
          if (!seg2) {
            area += (area ? " M " : "M ") + r1(cx(i4)) + " " + base + " L " + r1(cx(i4)) + " " + r1(yOf(pv2));
            segStart = i4; seg2 = true;
          } else area += " L " + r1(cx(i4)) + " " + r1(yOf(pv2));
        }
        if (area) body += '<path class="zu-sv3-area" fill="' + srs.color + '" d="' + area + '"/>';
      }
      /* 数据点：只落真实点（虚线总体不加点） */
      if (!srs.dashed) for (var i5 = 0; i5 < srs.pts.length; i5++) if (srs.pts[i5] != null)
        body += '<circle class="zu-sv3-pt' + (srs.color ? "" : " zu-sv3-npt") + '" cx="' + r1(cx(i5)) +
          '" cy="' + r1(yOf(srs.pts[i5])) + '" r="2.5"' + (srs.color ? ' fill="' + srs.color + '"' : "") + "/>";
      /* 末端数值标签：取各系列最后一个非空点 */
      if (weekForm) for (var i6 = srs.pts.length - 1; i6 >= 0; i6--) if (srs.pts[i6] != null) {
        labels.push({ y0: yOf(srs.pts[i6]), text: srs.pts[i6].toFixed(1), color: srs.color, dim: srs.dashed || !srs.color });
        break;
      }
    }
    /* 端标签上下错开 ≥12px：先向下推，越底再从末尾回推（全部钳在绘图区内） */
    labels.sort(function (a, b) { return a.y0 - b.y0; });
    var minY = TOP + 8, maxY = base - 3;
    for (var e1 = 1; e1 < labels.length; e1++) if (labels[e1].y0 - labels[e1 - 1].y0 < 12) labels[e1].y0 = labels[e1 - 1].y0 + 12;
    if (labels.length && labels[labels.length - 1].y0 > maxY) {
      labels[labels.length - 1].y0 = maxY;
      for (var e2 = labels.length - 2; e2 >= 0; e2--) if (labels[e2 + 1].y0 - labels[e2].y0 < 12) labels[e2].y0 = labels[e2 + 1].y0 - 12;
    }
    for (var e3 = 0; e3 < labels.length; e3++) {
      var lb = labels[e3];
      body += '<text class="zu-sv3-elabel' + (lb.dim ? " zu-sv3-olabel" : "") + '" x="' + (W - 2) +
        '" y="' + r1(lb.y0 + 3) + '"' + (lb.color ? ' fill="' + lb.color + '"' : "") + ">" + lb.text + "</text>";
    }
    /* 命中列 + 同组十字参考线（CSS :hover/:focus-within 显现，零 JS 监听） */
    var hits = "";
    for (var hi = 0; hi < N; hi++) {
      hits += '<g class="zu-sv3-hg"><line class="zu-sv3-xline" x1="' + r1(cx(hi)) + '" x2="' + r1(cx(hi)) +
        '" y1="' + TOP + '" y2="' + base + '"/>' +
        '<rect class="zu-sv3-hit" data-i="' + hi + '" x="' + (GX + hi * P) + '" y="' + TOP +
        '" width="' + P + '" height="' + PLOT + '" tabindex="0" role="img" aria-label="' +
        spdEsc(spd3HitAria(an, slots[hi])) + '"/></g>';
    }
    SPD_PORTAL = spd3PortalFor(slots, hoverIdx, o);
    return SPD3_CHART_CSS +
      '<div class="zu-speed-chart zu-sv3-chart">' + (head || "") +
      '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu-sc-plot" style="width:' + W + "px;height:" + H +
      'px;margin-left:0;min-width:0">' +
      '<svg class="zu-sv3-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '">' +
      grid + xtxt + body + hits + "</svg></div></div></div>";
  }
  /* ==================== ⑩ week：近 7 天（单模型线+面积 / 多模型线+总体虚线） ====================
   * X 轴恒 7 个本地日（含无数据日：无点断线，不插值不假填）；缺失日合成空桶供命中
   * 列与 aria（悬停无卡）。日历用本地 Date 运算，不减固定毫秒数。 */
  function spd3WeekSlots(an) {
    var dN = new Date(), nowMs = Date.now();
    var byA = {};
    for (var i = 0; i < an.items.length; i++) {
      var it = an.items[i];
      if (it && !it.empty) byA[it.a] = it;
    }
    var slots = [];
    for (var k = 0; k < 7; k++) {
      var t0 = new Date(dN.getFullYear(), dN.getMonth(), dN.getDate() - (6 - k)).getTime();
      var it2 = byA[t0] || null;
      if (!it2) it2 = { v: null, empty: true, label: spdLabel(t0, "day", true),
        full: spdFull(t0) + " – " + spdFull(Math.min(t0 + 864e5, nowMs) - 1), a: t0, b: t0 + 864e5, models: [] };
      slots.push(it2);
    }
    return slots;
  }
  function spd3WeekHTML(an, hoverIdx, o) {
    var head = spd3ChartHeadHTML(an, "") || "";
    return spd3LineHTML(an, hoverIdx, o, spd3WeekSlots(an), head, true);
  }
  /* ==================== ⑪ 三形态分发（唯一入口） ==================== */
  function spd3ChartHTML(an, hoverIdx, o) {
    SPD_PORTAL = "";   /* 每次构建先清悬停卡侧信道（消费即清纪律的写入侧对偶） */
    if (!an || !Array.isArray(an.items)) return "";
    if (an.period === "today") return spd3TodayHTML(an, hoverIdx, o);
    if (an.period === "week") return spd3WeekHTML(an, hoverIdx, o);
    if (an.period === "recent") return spd3RecentHTML(an, hoverIdx, o);
    return "";   /* month/all 热力形态归 heat 分片，本函数不画 */
  }
  /* SPD_V3_CHARTS_END */
