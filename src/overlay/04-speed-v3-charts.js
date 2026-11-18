  /* ---------- v384 生成速度 Tooltip V3：图表分片（近/今/近7天三形态 + 悬停卡，纯字符串） ----------
   * spec §5 三图表形态 + §2 模型色 + §7 悬停卡契约 + §11.2 槽位满幅（v387 实机修复批）。
   * 本分片只做字符串拼装（零 DOM），唯一副作用是给模块外变量 SPD_PORTAL 赋值（02 分片
   * 声明的悬停卡侧信道，宿主 spdHoverPortalSync 既有机制消费即清）：每次构建先置空串，
   * 有悬停才写卡串。数据上游 = 04-speed-v3-core.js 的 spd3Analyze 产物 an（结果只读，
   * 绝不原地改）；图表头 spd3ChartHeadHTML(an, sub) 由 view 分片提供（V3 集成后同 IIFE
   * 可达）。只引用存活符号：L / SPD_L / TPS_BANDS / tpsBand / spdEsc / spdNum / spdFull /
   * spdLabel / spdCompactRange + core 的 spd3Color / spd3ModelKey。V2 专属函数
   * （spdChartHTML/spdCardHTML/spdChartLayout 等）一律不引用：Y 轴整洁刻度阶梯在本
   * 文件实现 spd3Ticks（算法与 V2 同构：1/2/2.5/5/6/7.5×10^k，同档先 ×4 后 ×5，
   * need ≥ maxV×1.12）。month/all 热力形态归 heat 分片，本函数对未知 period 返回
   * 空串（错接线显性暴露，不静默画错图）。横向几何 v387 起恒满幅：柱图走槽位 flex
   * （.zu-sv3-slot 均摊 100%）、折线走 width="100%" + 百分比 x 坐标，无固定柱距、
   * 无 spacer/min-width 撑宽路径；v388（§12.3）plot 改 width:auto（margin-left 之外
   * 剩余宽自然填满，根除 100%+margin-left 组合的 30px 幻影溢出），柱组 n≤8 按
   * n×maxPitch 密度收窄居中（§12.3 分档）。样式全部 .zu-sv3- 前缀并集中在常量
   * SPD3_CHART_CSS（只在 recent/today/week 三分支产物头部出现一次；.zu-sc-* 基础
   * 类沿用宿主 06 分片静态样式，这里只做 V3 作用域覆写）。本文件可独立
   * node --check、可单独切片进 VM 夹具。 */
  /* SPD_V3_CHARTS_BEGIN */
  /* ==================== ① 几何常量与 Y 轴整洁刻度 ====================
   * 几何纪律（.zcode/rules/overlay-ui.md §5 + spec §11.2）：柱区/绘图区固定 px 不随
   * --ui-font-size，读数一位小数；纵向定高、横向满幅自适应（flex 槽位 / 百分比 x），
   * 不再有固定柱距与横滚撑宽。 */
  /* v388 §12.5：today/week 绘图区降为紧凑档，PLOT 200px 实测校准（v387 档 148 偏局促；
   * 柱/折线共用同一常量，Tab 切换绘图区不跳高）。CSS 内全部高度均由常量拼接，
   * hit 列（height=PLOT）与 svg（height=PLOT+X_H）天然一致。 */
  var SPD3_PLOT_H = 200;   /* 柱区 / 折线绘图区固定高（px） */
  var SPD3_X_H = 16;       /* X 轴标签带高（px） */
  var SPD3_GUT_W = 30;     /* Y 轴刻度列宽（px，= 柱图 plot 左缩进，刻度走 HTML gutter） */
  /* 绘图区估宽（spec §11.2 / PRD 3.2）：V3 卡 920 − 左卡 250 − gap/padding。
   * 估宽仅用于标签密度（数值让位、X 隔槽），布局由 flex 自适应，不参与任何几何。 */
  var SPD3_PLOT_W_EST = 620;
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
   * 柱组容器/几何在本表自带，不依赖其存留。plot 定宽（spec §12.3）：块级元素
   * width:auto + margin-left:30 → 在剩余空间内自动填满，右缘=wrap 内容右缘（v387 的
   * width:100% 相对 wrap 内容宽、叠加自身 margin-left 曾致 plot 右缘 636>606 的 30px
   * 幻影溢出，真机滚动条直证）；折线 svg width=100% 在 plot 内层，% 坐标随缩窄后的
   * plot 自洽（今日/week 的 x 百分比几何不受影响）。wrap 保留 overflow-x:auto 与
   * 滚动条隐藏纯作防御（基础 min-width:340px 窄窗下限仍在 06 分片）。 */
  var SPD3_CHART_CSS = "<style>" +
    /* 容器与滚动 */
    ".zu-sv3-chart{display:flex;flex-direction:column;min-height:0}" +
    ".zu-sv3-chart .zu-sv-empty{flex:1;min-height:120px}" +
    ".zu-sv3-chart .zu-sc-wrap{flex:1;min-height:0;padding:5px 0;box-sizing:border-box;overflow-x:auto;overflow-y:hidden;width:100%}" +
    /* plot：width:auto（块级+margin-left 自动填剩余，§12.3 幻影溢出根除，不隐藏滚动条
     * 掩盖）；高 = 柱区 PLOT + X 轴 X_H（v388 紧凑档 200+16=216）；左缩进留给 Y 沟槽 */
    ".zu-sv3-chart .zu-sc-plot{height:" + (SPD3_PLOT_H + SPD3_X_H) + "px;margin-left:" + SPD3_GUT_W + "px;min-width:0;width:auto;box-sizing:border-box}" +
    ".zu-sv3-chart .zu-sc-grid,.zu-sv3-chart .zu-sc-gutter{height:" + SPD3_PLOT_H + "px}" +
    ".zu-sv3-chart .zu-sc-wrap::-webkit-scrollbar{display:none}" +
    /* 柱组：槽位 flex 平铺满幅——每槽 .zu-sv3-slot flex:1 1 0 均摊（min-width:0 防内容
     * 撑宽），两侧 5px 呼吸边距承担旧 spacer 的缘上呼吸；无 justify-content 挤左路径。
     * v388 §12.3 密度分档（max-width 随槽数 n 变化）以内联 style 追加在本规则之上
     * （见 spd3BarDensityStyle），CSS 类无法按 n 取值故不在此处声明 */
    ".zu-sv3-bars{position:absolute;inset:0;display:flex;width:100%;padding:0 5px;box-sizing:border-box}" +
    ".zu-sv3-bars .zu-sc-col{flex:1 1 0;min-width:0;height:100%;position:relative}" +
    ".zu-sv3-bars .zu-sc-vz{flex:0 0 " + SPD3_PLOT_H + "px;height:" + SPD3_PLOT_H + "px}" +
    /* 柱宽密度三档（spec §11.2 / PRD 3.1）：n≤6→18 / n≤12→14 / 其余→10px，槽内居中 */
    ".zu-sv3-bars.zu-sv3-w18 .zu-sc-bar{width:18px;max-width:18px}" +
    ".zu-sv3-bars.zu-sv3-w14 .zu-sc-bar{width:14px;max-width:14px}" +
    ".zu-sv3-bars.zu-sv3-w10 .zu-sc-bar{width:10px;max-width:10px}" +
    ".zu-sv3-bars .zu-sc-x{height:" + SPD3_X_H + "px;flex:0 0 " + SPD3_X_H + "px;overflow:hidden;font-size:7px}" +
    ".zu-sv3-bars .zu-sc-x b{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;text-align:center;line-height:14px}" +
    /* 隔槽隐藏标签：visibility 占位（槽几何不变），首/末/悬停槽恒显在构建侧判定 */
    ".zu-sv3-bars .zu-sc-x b.zu-sv3-xoff{visibility:hidden}" +
    /* 槽 hover 十字参考线（纯 CSS 显现，零 JS 监听；随槽位水平居中） */
    ".zu-sv3-bars .zu-sv3-xline{position:absolute;left:50%;top:0;width:0;height:" + SPD3_PLOT_H + "px;border-left:1px dashed var(--color-border,rgba(255,255,255,.3));opacity:0;pointer-events:none}" +
    ".zu-sv3-bars .zu-sc-col:hover>.zu-sv3-xline,.zu-sv3-bars .zu-sc-col:focus-within>.zu-sv3-xline{opacity:1}" +
    ".zu-sv3-bars .zu-sc-col.empty .zu-sc-bar{background:transparent;box-shadow:none}" +
    ".zu-sv3-bars .zu-sc-col.cur .zu-sc-val{font-weight:700}" +
    ".zu-sv3-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px var(--color-popover-border,rgba(255,255,255,.28))}" +
    ".zu-light .zu-sv3-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px rgba(15,23,42,.22)}" +
    /* 混合轮中性灰（spec §5：不得用主导模型色填满混合轮） */
    ".zu-sv3-chart .zu-sc-bar.zu-sv3-mix{background:var(--color-tooltip-tag-foreground,#8a8f98)}" +
    /* SVG 折线（今天多模型 / 近 7 天）：width=100% 满幅、x 全百分比、y/线宽/圆点 px；
     * overflow:visible 让峰值圆点/端标签可越出 svg 顶（wrap 5px padding 内不裁） */
    ".zu-sv3-svg{display:block;overflow:visible}" +
    /* 面积载体：嵌套 svg 用 viewBox 0..100 百分比坐标（preserveAspectRatio=none），
     * 纯填充无描边，横向拉伸不失真；不接指针（命中列在其上层） */
    ".zu-sv3-asvg{display:block;pointer-events:none}" +
    ".zu-sv3-line{fill:none;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}" +
    ".zu-sv3-nline{stroke:var(--color-tooltip-tag-foreground,#8a8f98)}" +
    ".zu-sv3-area{stroke:none;fill-opacity:.12}" +
    ".zu-sv3-oline{fill:none;stroke:var(--color-tooltip-tag-foreground,#8a8f98);stroke-width:1.4;stroke-dasharray:4 3}" +
    ".zu-sv3-pt{stroke:none}" +
    ".zu-sv3-npt{fill:var(--color-tooltip-tag-foreground,#8a8f98)}" +
    ".zu-sv3-xtxt{fill:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:8px;text-anchor:middle;font-variant-numeric:tabular-nums}" +
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
  /* 柱图网格线 + Y 轴刻度标签（HTML 绝对定位结构：0 基线加粗、顶刻度钉在 100%-13px；
   * 横线 left:0;right:0 即 % 宽满幅，柱图/折线共用） */
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
  /* ==================== ④ 柱状图槽位列构建（recent / 今天单模型共用） ====================
   * 槽位满幅（spec §11.2）：每槽 .zu-sv3-slot flex:1 1 0 均摊全宽，槽即命中区
   * （data-i/tabindex/role/aria/混合 title 契约全在槽上），柱按密度 18/14/10px 槽内
   * 水平居中。数值标签（PRD 3.2）：n≤8 全显；>8 时 峰值/最低/最新/悬停 恒显 + 其余按
   * valEvery=ceil(n/8) 抽稀，估宽=字符数×6px+8 超槽宽（SPD3_PLOT_W_EST/n）让位跳过，
   * 绝不重叠。X 标签每槽显示，估宽 <34px 且 n>10 时隔槽显示（首/末/悬停恒显），
   * b 兜底 ellipsis。柱色规则（spec §5）：行 models.length===1 → 柱色=spd3Color(模型
   * key)（内联 background，速度档位色阶不再上柱体）；>1 → .zu-sv3-mix 中性灰（绝不
   * 用主导模型色）+ title/aria 标「混合」；=0（旧帧无 msl）→ 中性默认色。柱顶读数
   * 一位小数；最新柱（最右）latest 描边。 */
  function spd3BarCols(items, hoverIdx, yMax) {
    var n = items.length, valEvery = Math.max(1, Math.ceil(n / 8));
    var slotW = SPD3_PLOT_W_EST / Math.max(n, 1);
    var xThin = n > 10 && slotW < 34, cols = "";
    var peakI = -1, minI = -1;
    for (var p = 0; p < n; p++) {
      var pv = items[p].empty ? 0 : spdNum(items[p].v);
      if (pv > 0) {
        if (peakI < 0 || pv > spdNum(items[peakI].v)) peakI = p;
        if (minI < 0 || pv < spdNum(items[minI].v)) minI = p;
      }
    }
    for (var c = 0; c < n; c++) {
      var it = items[c], isCur = c === hoverIdx, empty = !!it.empty;
      var mcolor = "", mix = false, mname = "";
      if (!empty && it.models && it.models.length) {
        if (it.models.length === 1) { mcolor = spd3Color(spd3ModelKey(it.models[0])); mname = it.models[0].name || ""; }
        else mix = true;
      }
      var vv = spdNum(it.v);
      var hPct = empty || !(vv > 0) ? 0 : Math.max(1.2, Math.round(vv / yMax * 1000) / 10);
      var txt = vv.toFixed(1);
      /* 恒显集合（峰值/最低/最新/悬停）不吃估宽让位；其余采样位超槽宽即跳过 */
      var shown = !empty && (n <= 8 || isCur || c === n - 1 || c === peakI || c === minI ||
        (c % valEvery === 0 && txt.length * 6 + 8 <= slotW));
      var xShow = !xThin || c % 2 === 0 || c === n - 1 || c === hoverIdx;
      var aria = it.label + SPD_L("，", ", ") + (empty || !(vv > 0) ? SPD_L("无数据", "no data") : (vv.toFixed(1) + " t/s")) +
        (mname ? SPD_L("，", ", ") + mname : "") + (mix ? SPD_L("，", ", ") + SPD_L("混合", "mixed") : "");
      cols += '<div class="zu-sc-col' + (isCur ? " cur" : "") + (empty ? " empty" : "") +
        (c === n - 1 ? " latest" : "") + ' zu-sv3-slot" role="img" tabindex="0" data-i="' + c + '"' +
        (mix ? ' title="' + spdEsc(SPD_L("混合（" + it.models.length + " 种模型）", "Mixed (" + it.models.length + " models)")) + '"' : "") +
        ' aria-label="' + spdEsc(aria) + '">' +
        '<span class="zu-sc-vz"><span class="zu-sc-val">' + (shown ? txt : "") + "</span>" +
        '<i class="zu-sc-bar' + (mix ? " zu-sv3-mix" : "") + '" style="height:' + hPct + "%" +
        (mcolor ? ";background:" + mcolor : "") + '"></i></span>' +
        '<span class="zu-sc-x"><b' + (xShow ? "" : ' class="zu-sv3-xoff"') + ">" + spdEsc(it.label) + "</b></span>" +
        '<i class="zu-sv3-xline"></i></div>';
    }
    return cols;
  }
  /* 柱图密度分档（spec §12.3）：槽 flex:1 1 0 满幅保留，柱组整体按 槽数×最大柱心距
   * 收窄并水平居中——n≤3 → maxPitch=120px（1 轮视觉居中、2-3 轮居中分组，禁止两柱
   * 顶到两端）；n≤8 → 140px（估宽 620 下 n≥5 即 100% 吃满，上限通常不触发=满幅均衡）；
   * n>8 不设上限（紧凑满幅）。max-width 值依赖 n，CSS 类无法表达 n×pitch，故以
   * 内联 style 下发；柱组 absolute（inset:0）下 width:100% 被上限收窄后由 margin:0
   * auto 的 auto 边距均分居中（CSS2.1 §10.3.7），n>8 无上限时不出内联（恒满幅）。
   * 柱宽密度三档 18/14/10 与槽位均摊不变。 */
  function spd3BarDensityStyle(n) {
    var pitch = n <= 3 ? 120 : n <= 8 ? 140 : 0;
    return pitch ? ' style="max-width:min(100%,' + (n * pitch) + 'px);margin:0 auto"' : "";
  }
  /* 柱图满幅框架：plot auto 宽 + HTML 网格/沟槽 + 槽位 flex 柱组（宽度密度类 + 密度
   * 分档内联 style 同挂柱组） */
  function spd3BarsFrame(gt, n, cols) {
    return '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu-sc-plot">' +
      '<span class="zu-sc-grid">' + gt.grid + '</span>' +
      '<span class="zu-sc-gutter">' + gt.gutter + '</span>' +
      '<span class="zu-sv3-bars zu-sv3-w' + (n <= 6 ? 18 : n <= 12 ? 14 : 10) + '"' + spd3BarDensityStyle(n) + ">" + cols + "</span></div></div>";
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
      spd3BarsFrame(gt, n, spd3BarCols(items, hoverIdx, tk.yMax)) + "</div>";
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
        spd3BarsFrame(gt, n, spd3BarCols(items, hoverIdx, tk.yMax)) + "</div>";
    }
    return spd3LineHTML(an, hoverIdx, o, items, head, false);
  }
  /* ==================== ⑨ 折线图共用（今天多模型 / 近 7 天） ====================
   * 满幅（spec §11.2）：svg width="100%" 无 viewBox，x 全百分比（槽中心=(i+0.5)/N×100%，
   * 端标签收进 99.2% + text-anchor:end），y/线宽/圆点恒 px 不失真。每系列一组分段
   * <line>（相邻非空点一连，缺口断线不插值：null 即断段）；数据点 circle r=2.5 只落
   * 真实点；命中列 rect（data-i=桶序号，x/width 均 %）承载悬停/键盘，同组内竖线十字
   * 参考线由 CSS :hover/:focus-within 显现。Y 轴刻度/网格走 HTML gutter/grid（% 宽
   * 横线），与柱图同构。端数值标签仅单模型绘制（每线一枚=末个非空点，PRD 10.2 每线
   * 仅端标签；v388 §12.5 起 today/week 多模型 perModel>1 默认不画——多线右缘堆叠实测
   * 重叠，全模型数值经悬停十字卡），上下错开 ≥12px；weekForm 近 7 天附加中性虚线
   * 「总体」与单模型分段
   * 面积（嵌套 svg viewBox 0..100 百分比坐标，纯填充拉伸不失真）——spec §5 的总体线
   * 是 week 多模型专属。 */
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
    var N = Math.max(slots.length, 1);
    var PLOT = SPD3_PLOT_H, XH = SPD3_X_H, BASE = PLOT, H = PLOT + XH;
    /* 百分比 x（保留 3 位小数）：槽中心 / hit 列几何全部随 100% 宽自适应 */
    var pc = function (x) { return Math.round(x * 1000) / 1000; };
    var xc = function (i) { return pc((i + 0.5) * 100 / N); };
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
    var tk = spd3Ticks(maxV), gt = spd3GridTicks(tk);
    var yOf = function (v) { return (1 - v / tk.yMax) * PLOT; };
    var r1 = function (x) { return Math.round(x * 10) / 10; };
    var xtxt = "", areas = "", body = "", labels = [];
    /* X 轴标签：week 恒 7 日；today 隔 3 小时（00/03/06…）+ 末槽恒显（spec §11.2）；
     * 非 HH:MM 标签按显处理（防御未知粒度） */
    for (var xi = 0; xi < slots.length; xi++) {
      var lb2 = (slots[xi] && slots[xi].label) || "";
      var hm = /^(\d{1,2}):/.exec(lb2);
      if (!(weekForm || !hm || xi === slots.length - 1 || Number(hm[1]) % 3 === 0)) continue;
      xtxt += '<text class="zu-sv3-xtxt" x="' + xc(xi) + '%" y="' + (BASE + 11) + '">' + spdEsc(lb2) + "</text>";
    }
    for (var si = 0; si < series.length; si++) {
      var srs = series[si], segs = "", segOpen = false, sx = 0, sy = 0;
      for (var i3 = 0; i3 < srs.pts.length; i3++) {
        if (srs.pts[i3] == null) { segOpen = false; continue; }
        var nx = xc(i3), ny = r1(yOf(srs.pts[i3]));
        if (segOpen) segs += '<line x1="' + sx + '%" y1="' + sy + '" x2="' + nx + '%" y2="' + ny + '"/>';
        sx = nx; sy = ny; segOpen = true;
      }
      if (segs) body += '<g class="zu-sv3-line' + (srs.color ? "" : " zu-sv3-nline") +
        (srs.dashed ? " zu-sv3-oline" : "") + '"' + (srs.color ? ' stroke="' + srs.color + '"' : "") + ">" + segs + "</g>";
      /* 近 7 天单模型实线：分段面积（模型色 12% 透明度，缺口不填充）；面积载体是
       * 嵌套 svg（viewBox 0..100 百分比坐标、preserveAspectRatio=none，纯填充无描边，
       * 横向拉伸不失真）。v384 S6-MINOR5：多模型周视图纯折线+虚线总体（设计稿无面积） */
      if (weekForm && !srs.dashed && srs.color && !multi) {
        var area = "", seg2 = false, segStart = 0;
        for (var i4 = 0; i4 <= srs.pts.length; i4++) {
          var pv2 = i4 < srs.pts.length ? srs.pts[i4] : null;
          if (pv2 == null) {
            if (seg2) {
              area += " L " + xc(i4 - 1) + " " + BASE + " L " + xc(segStart) + " " + BASE + " Z";
              seg2 = false;
            }
            continue;
          }
          if (!seg2) {
            area += (area ? " M " : "M ") + xc(i4) + " " + BASE + " L " + xc(i4) + " " + r1(yOf(pv2));
            segStart = i4; seg2 = true;
          } else area += " L " + xc(i4) + " " + r1(yOf(pv2));
        }
        if (area) areas += '<path class="zu-sv3-area" fill="' + srs.color + '" d="' + area + '"/>';
      }
      /* 数据点：只落真实点（虚线总体不加点） */
      if (!srs.dashed) for (var i5 = 0; i5 < srs.pts.length; i5++) if (srs.pts[i5] != null)
        body += '<circle class="zu-sv3-pt' + (srs.color ? "" : " zu-sv3-npt") + '" cx="' + xc(i5) +
          '%" cy="' + r1(yOf(srs.pts[i5])) + '" r="2.5"' + (srs.color ? ' fill="' + srs.color + '"' : "") + "/>";
      /* 端数值标签：仅单模型（单线）每线一枚（末个非空点）；多模型（perModel>1，
       * today/week 同款）默认不画——多线右缘堆叠实测重叠（spec §12.5 / PRD 10.2/9.4），
       * 数值经悬停十字卡与数据点承载。降级多模型（msAvail=false 单中性线）同样跳过，
       * 判据恒为 perModel>1 */
      if (!multi) for (var i6 = srs.pts.length - 1; i6 >= 0; i6--) if (srs.pts[i6] != null) {
        labels.push({ y0: yOf(srs.pts[i6]), text: srs.pts[i6].toFixed(1), color: srs.color, dim: srs.dashed || !srs.color });
        break;
      }
    }
    /* 端标签上下错开 ≥12px：先向下推，越底再从末尾回推（全部钳在绘图区内） */
    labels.sort(function (a, b) { return a.y0 - b.y0; });
    var minY = 6, maxY = BASE - 3;
    for (var e1 = 1; e1 < labels.length; e1++) if (labels[e1].y0 - labels[e1 - 1].y0 < 12) labels[e1].y0 = labels[e1 - 1].y0 + 12;
    if (labels.length && labels[labels.length - 1].y0 > maxY) {
      labels[labels.length - 1].y0 = maxY;
      for (var e2 = labels.length - 2; e2 >= 0; e2--) if (labels[e2 + 1].y0 - labels[e2].y0 < 12) labels[e2].y0 = labels[e2 + 1].y0 - 12;
    }
    for (var e3 = 0; e3 < labels.length; e3++) {
      var lb3 = labels[e3];
      body += '<text class="zu-sv3-elabel' + (lb3.dim ? " zu-sv3-olabel" : "") + '" x="99.2%" y="' +
        r1(lb3.y0 + 3) + '"' + (lb3.color ? ' fill="' + lb3.color + '"' : "") + ">" + lb3.text + "</text>";
    }
    /* 命中列（x/width 均 %）+ 同组十字参考线（CSS :hover/:focus-within 显现，零 JS 监听） */
    var hits = "";
    for (var hi = 0; hi < slots.length; hi++) {
      hits += '<g class="zu-sv3-hg"><line class="zu-sv3-xline" x1="' + xc(hi) + '%" x2="' + xc(hi) +
        '%" y1="0" y2="' + BASE + '"/>' +
        '<rect class="zu-sv3-hit" data-i="' + hi + '" x="' + pc(hi * 100 / N) + '%" y="0" width="' +
        pc(100 / N) + '%" height="' + PLOT + '" tabindex="0" role="img" aria-label="' +
        spdEsc(spd3HitAria(an, slots[hi])) + '"/></g>';
    }
    SPD_PORTAL = spd3PortalFor(slots, hoverIdx, o);
    return SPD3_CHART_CSS +
      '<div class="zu-speed-chart zu-sv3-chart">' + (head || "") +
      '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu-sc-plot">' +
      '<span class="zu-sc-grid">' + gt.grid + '</span>' +
      '<span class="zu-sc-gutter">' + gt.gutter + '</span>' +
      '<svg class="zu-sv3-svg" width="100%" height="' + H + '">' +
      (areas ? '<svg class="zu-sv3-asvg" width="100%" height="' + PLOT +
        '" viewBox="0 0 100 ' + PLOT + '" preserveAspectRatio="none">' + areas + "</svg>" : "") +
      xtxt + body + hits + "</svg></div></div></div>";
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
    var slots = spd3WeekSlots(an);
    /* 覆盖提示（spec §12.5）：head sub 轻量小字「有效 X/7 天」，X=7 日槽非空数；
     * 仅 week 且 X<7 时追加（满 7 天不添噪） */
    var filled = 0;
    for (var f = 0; f < slots.length; f++) if (!slots[f].empty) filled++;
    var head = spd3ChartHeadHTML(an,
      filled < 7 ? SPD_L("有效 " + filled + "/7 天", filled + "/7 days with data") : "") || "";
    return spd3LineHTML(an, hoverIdx, o, slots, head, true);
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
