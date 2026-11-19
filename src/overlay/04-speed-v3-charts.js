  /* ---------- v384 生成速度 Tooltip V3：图表分片（近/今/近7天三形态 + 悬停卡，纯字符串） ----------
   * spec §5 三图表形态 + §2 模型色 + §7 悬停卡契约 + §11.2 槽位满幅（v387 实机修复批）。
   * v389（spec §13）：plot 弹性高（flex:1、X 标签带独立 16px 贴 plot 底；原 200..300 钳制，
   * v393 §17 五形态统一 450 起废除 300 上限，plot 吃满卡内剩余）、
   * 折线 y 坐标全百分比化（yPct(v)=2+(1−v/yMax)×98）、空槽轻卡「无有效速度记录」、
   * today/week 槽位增强卡统一走 spd3SlotCardHTML、折线两级 hover（列级卡=06/01 委托
   * 既有 + 线级视觉=纯 CSS .zu-sv3-lineg）。
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
   * （.zu-sv3-slot 均摊 100%）、折线走 width="100%" + 百分比 x/y 坐标（v389 §13.1 y
   * 百分比化，见 ⑨），无固定柱距、
   * 无 spacer/min-width 撑宽路径；v388（§12.3）plot 改 width:auto（margin-left 之外
   * 剩余宽自然填满，根除 100%+margin-left 组合的 30px 幻影溢出），柱组 n≤8 按
   * n×maxPitch 密度收窄居中（§12.3 分档）。样式全部 .zu-sv3- 前缀并集中在常量
   * SPD3_CHART_CSS（只在 recent/today/week 三分支产物头部出现一次；.zu-sc-* 基础
   * 类沿用宿主 06 分片静态样式，这里只做 V3 作用域覆写）。本文件可独立
   * node --check、可单独切片进 VM 夹具。 */
  /* SPD_V3_CHARTS_BEGIN */
  /* ==================== ① 几何常量与 Y 轴整洁刻度 ====================
   * 几何纪律（.zcode/rules/overlay-ui.md §5 + spec §11.2/§13.1）：柱区/绘图区不随
   * --ui-font-size，读数一位小数；纵向弹性（v389 §13.1 plot 200..300 吸收左卡/档位
   * 拉伸）、横向满幅自适应（flex 槽位 / 百分比 x/y），不再有固定柱距与横滚撑宽。
   * 值区（绘图区）恒 = plot 高 − X 轴带 16px：柱图 X 带在槽位列内（.zu-sc-x）、折线
   * X 带是 plot 内独立 xsvg，两条链的网格横线与数据 y 共用同一值区百分比坐标系。 */
  var SPD3_PLOT_H = 200;   /* plot 弹性高下限（px）；v393 §17 起无上限——max-height:300（v389 §13.1）随五形态统一 450 档废除，plot flex 吃满卡内剩余 */
  var SPD3_X_H = 16;       /* X 轴标签带高（px；柱图=槽位 .zu-sc-x，折线=plot 内 xsvg） */
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
   * 滚动条隐藏纯作防御；V3 已覆写 min-width:0，06 基础 340px 下限对 V3 不生效） */
  var SPD3_CHART_CSS = "<style>" +
    /* 容器与滚动 */
    ".zu-sv3-chart{display:flex;flex-direction:column;min-height:0}" +
    ".zu-sv3-chart .zu-sv-empty{flex:1;min-height:120px}" +
    /* wrap：flex 列 + justify-content:flex-end（v389 §13.1）——plot 拉伸到 300 封顶后
     * 多余高度留在 plot 上方，X 标签带恒贴 plot 底/卡底（距卡内边界 ≤28px，PRD §2.4） */
    ".zu-sv3-chart .zu-sc-wrap{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:flex-end;padding:5px 0;box-sizing:border-box;overflow-x:auto;overflow-y:hidden;width:100%}" +
    /* plot：width:auto（块级+margin-left 自动填剩余，§12.3 幻影溢出根除，不隐藏滚动条
     * 掩盖）；高弹性（v389 §13.1：flex:1、min PLOT_H 200、max 300，吸收左卡/档位拉伸）
     * ——CSS 内不再有固定 216/200px 高度，svg/hit/网格/柱高全部随值区百分比自适应 */
    ".zu-sv3-chart .zu-sc-plot{flex:1 1 auto;min-height:" + SPD3_PLOT_H + "px;margin-left:" + SPD3_GUT_W + "px;min-width:0;width:auto;box-sizing:border-box}" +
    /* 网格/沟槽 = 值区高：值区恒 = plot − X 轴带 16px（柱图 X 带在槽位列内、折线 X 带
     * 是 plot 内独立 xsvg），横线 bottom:% 与数据 y% 同一坐标系对齐 */
    ".zu-sv3-chart .zu-sc-grid,.zu-sv3-chart .zu-sc-gutter{height:calc(100% - " + SPD3_X_H + "px)}" +
    /* v389 P0（真机 ：hover 链实证）：grid/gutter 是 absolute 定位层，按 CSS 绘制顺序
     * 压在非定位的折线 svg 之上——真实鼠标命中 grid，.zu-sv3-hit 永远收不到
     * mouseover（合成 dispatchEvent 绕过 hit-testing，历轮验证全被它骗过）。
     * grid/gutter 纯装饰改 pointer-events:none；svg 提 position:relative 回到
     * 定位层，hit 列恢复真实可达。 */
    ".zu-sv3-chart .zu-sc-grid,.zu-sv3-chart .zu-sc-gutter{pointer-events:none}" +
    ".zu-sv3-chart .zu-sv3-svg{position:relative}" +
    ".zu-sv3-chart .zu-sc-wrap::-webkit-scrollbar{display:none}" +
    /* 柱组：槽位 flex 平铺满幅——每槽 .zu-sv3-slot flex:1 1 0 均摊（min-width:0 防内容
     * 撑宽），两侧 5px 呼吸边距承担旧 spacer 的缘上呼吸；无 justify-content 挤左路径。
     * v388 §12.3 密度分档（max-width 随槽数 n 变化）以内联 style 追加在本规则之上
     * （见 spd3BarDensityStyle），CSS 类无法按 n 取值故不在此处声明 */
    ".zu-sv3-bars{position:absolute;inset:0;display:flex;width:100%;padding:0 5px;box-sizing:border-box}" +
    ".zu-sv3-bars .zu-sc-col{flex:1 1 0;min-width:0;height:100%;position:relative}" +
    /* 值区 vz 弹性（v389 §13.1）：flex:1 吃掉槽内除 X 带（16px）外的全部高度，
     * 柱高 % 随值区自适应（原固定 200px 不再出现） */
    ".zu-sv3-bars .zu-sc-vz{flex:1 1 auto;min-height:0;height:auto}" +
    /* 柱宽密度三档（spec §11.2 / PRD 3.1）：n≤6→18 / n≤12→14 / 其余→10px，槽内居中 */
    ".zu-sv3-bars.zu-sv3-w18 .zu-sc-bar{width:18px;max-width:18px}" +
    ".zu-sv3-bars.zu-sv3-w14 .zu-sc-bar{width:14px;max-width:14px}" +
    ".zu-sv3-bars.zu-sv3-w10 .zu-sc-bar{width:10px;max-width:10px}" +
    ".zu-sv3-bars .zu-sc-x{height:" + SPD3_X_H + "px;flex:0 0 " + SPD3_X_H + "px;overflow:hidden;font-size:7px}" +
    ".zu-sv3-bars .zu-sc-x b{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;text-align:center;line-height:14px}" +
    /* 隔槽隐藏标签：visibility 占位（槽几何不变），首/末/悬停槽恒显在构建侧判定 */
    ".zu-sv3-bars .zu-sc-x b.zu-sv3-xoff{visibility:hidden}" +
    /* §15.5 首末柱标签防裁切：estW>slotW 时钉在槽内缘（align-self 覆盖列居中），
     * 不越出 plot 左右缘（曾可触发 wrap 横滚） */
    ".zu-sv3-bars .zu-sc-val.zu-sv3-vpin-l{align-self:flex-start}" +
    ".zu-sv3-bars .zu-sc-val.zu-sv3-vpin-r{align-self:flex-end}" +
    /* 槽 hover 十字参考线（纯 CSS 显现，零 JS 监听；随槽位水平居中，高=值区） */
    ".zu-sv3-bars .zu-sv3-xline{position:absolute;left:50%;top:0;width:0;height:calc(100% - " + SPD3_X_H + "px);border-left:1px dashed var(--color-border,rgba(255,255,255,.3));opacity:0;pointer-events:none}" +
    ".zu-sv3-bars .zu-sc-col:hover>.zu-sv3-xline,.zu-sv3-bars .zu-sc-col:focus-within>.zu-sv3-xline{opacity:1}" +
    ".zu-sv3-bars .zu-sc-col.empty .zu-sc-bar{background:transparent;box-shadow:none}" +
    ".zu-sv3-bars .zu-sc-col.cur .zu-sc-val{font-weight:700}" +
    ".zu-sv3-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px var(--color-popover-border,rgba(255,255,255,.28))}" +
    ".zu-light .zu-sv3-bars .zu-sc-col.latest .zu-sc-bar{box-shadow:0 0 0 1.5px rgba(15,23,42,.22)}" +
    /* 混合轮中性灰（spec §5：不得用主导模型色填满混合轮） */
    ".zu-sv3-chart .zu-sc-bar.zu-sv3-mix{background:var(--color-tooltip-tag-foreground,#8a8f98)}" +
    /* SVG 折线（今天多模型 / 近 7 天）：width/height 均 100% 满幅（v389 §13.1 弹性高：
     * 高=值区=plot−16px X 带，CSS calc 覆盖 height 属性），x/y 全百分比（y% 公式：
     * yPct(v)=2+(1−v/yMax)×98，顶部余量 2%），线宽/圆点半径恒 px 不失真；X 标签在
     * 下方独立 xsvg。overflow:visible 让峰值圆点/端标签可越出 svg 顶（wrap padding 内不裁） */
    ".zu-sv3-svg{display:block;overflow:visible;height:calc(100% - " + SPD3_X_H + "px)}" +
    /* X 轴标签带：值区 svg 下方的独立 16px 带（plot 内块级堆叠，calc(100%−16)+16 正好
     * 铺满 plot），标签 text y=11px、x 仍百分比，恒贴 plot 底 */
    ".zu-sv3-xsvg{display:block;height:" + SPD3_X_H + "px}" +
    /* 面积载体：嵌套 svg 用 viewBox 0..100 百分比坐标（preserveAspectRatio=none），
     * 纯填充无描边，拉伸不失真；不接指针（命中列/折线在其上层） */
    ".zu-sv3-asvg{display:block;pointer-events:none}" +
    ".zu-sv3-line{fill:none;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}" +
    ".zu-sv3-nline{stroke:var(--color-tooltip-tag-foreground,#8a8f98)}" +
    ".zu-sv3-area{stroke:none;fill-opacity:.12}" +
    ".zu-sv3-oline{fill:none;stroke:var(--color-tooltip-tag-foreground,#8a8f98);stroke-width:1.4;stroke-dasharray:4 3}" +
    ".zu-sv3-pt{stroke:none}" +
    ".zu-sv3-npt{fill:var(--color-tooltip-tag-foreground,#8a8f98)}" +
    /* 折线两级 hover（v389 §13.2，纯 CSS，零 JS 监听；06/01 列级委托不改）：列级卡=
     * hit 列 mouseover 经既有委托重编出卡；线级视觉=.zu-sv3-lineg（线+点同组，
     * data-m=模型键）画在命中列上层、pointer-events:stroke 只吃线体——hover 自身
     * 加粗（stroke-width 声明在 g 上、继承到分段 line），圆点 r 恒 px 不缩放、以
     * brightness 提亮；指针在任一线体上时容器 .zu-sv3-lines:hover 弱化兄弟线 */
    ".zu-sv3-lineg{pointer-events:stroke}" +
    ".zu-sv3-lineg:hover{stroke-width:2.6}" +
    ".zu-sv3-lineg:hover .zu-sv3-pt{filter:brightness(1.3)}" +
    ".zu-sv3-lines:hover .zu-sv3-lineg:not(:hover){opacity:.45}" +
    ".zu-sv3-xtxt{fill:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:8px;text-anchor:middle;font-variant-numeric:tabular-nums;pointer-events:none}" +
    ".zu-sv3-elabel{font-size:9.5px;font-weight:600;font-variant-numeric:tabular-nums;text-anchor:end;fill:var(--color-foreground,#e9edf4);pointer-events:none}" +
    ".zu-sv3-elabel.zu-sv3-olabel{fill:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:400}" +
    /* 悬停命中列与十字参考线（hover/focus 纯 CSS 显现，零 JS 监听；高=值区 100%；
     * 折线 g 在其上层，线体命中让位线级高亮） */
    ".zu-sv3-hit{fill:#000;fill-opacity:0;pointer-events:all;outline:none}" +
    ".zu-sv3-hit:focus-visible{stroke:var(--color-brand,#a3cfff);stroke-width:1.5}" +
    ".zu-sv3-xline{stroke:var(--color-border,rgba(255,255,255,.3));stroke-dasharray:3 3;opacity:0;pointer-events:none}" +
    ".zu-sv3-hg:hover .zu-sv3-xline,.zu-sv3-hg:focus-within .zu-sv3-xline{opacity:1}" +
    /* 悬停卡（模型组成行 + v389 §13.2 槽位卡；卡根 .zu-sv-card 基础样式由 06 分片提供） */
    ".zu-sv3-msub>b{overflow:hidden}" +
    ".zu-sv3-mi{display:flex;align-items:center;justify-content:flex-end;gap:5px;min-width:0;font-weight:400}" +
    ".zu-sv3-mdot{display:inline-block;width:8px;height:8px;border-radius:2px;flex:0 0 8px}" +
    ".zu-sv3-mname{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".zu-sv3-mv{font-style:normal;font-variant-numeric:tabular-nums;font-weight:600;flex:0 0 auto}" +
    ".zu-sv3-mt{font-style:normal;font-variant-numeric:tabular-nums;font-weight:400;opacity:.65;flex:0 0 auto}" +
    /* 槽位卡（v389 §13.2）：宽帽 ~260px（.zu-sv-card 基宽 252 已合规，帽为显式契约）；
     * 综合日均/均速大字（!important 压过 06 分片 .zu-sv-cval 12px）；同名异供应商
     * pid 尾段小字与「另有 N 个模型」汇总行 */
    ".zu-sv3-daycard{max-width:260px}" +
    ".zu-sv3-daycard .zu-sv-cval{font-size:15px!important}" +
    ".zu-sv3-pidsub{font-style:normal;font-weight:400;opacity:.6;font-size:9px}" +
    ".zu-sv3-more{font-weight:400;opacity:.7;font-style:normal}" +
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
  /* 悬停卡侧信道：有悬停才写卡（未悬停 = 空串 = Portal 收起）。v389 §13.2 分两形：
   * slotDay===undefined=legacy 轮卡（recent 专用，空桶静默）；传 true/false=槽位卡
   * （today 小时桶 / week 日桶统一走 spd3SlotCardHTML——空槽出轻卡不再静默）。 */
  function spd3PortalFor(items, hoverIdx, o, slotDay) {
    if (!(hoverIdx >= 0) || !items[hoverIdx]) return "";
    return slotDay === undefined
      ? (items[hoverIdx].empty ? "" : spd3HoverCardHTML(items[hoverIdx], o, hoverIdx))
      : spd3SlotCardHTML(items[hoverIdx], o, hoverIdx, !!slotDay);
  }
  /* ---- v389 §13.2 槽位卡辅助（today/week 共用；本地小件不外引，纪律同文件头） ---- */
  function spd3P2(v) { return (v < 10 ? "0" : "") + v; }
  /* 槽位星期副标（轻卡标题用）：zh「周X」，en 三字母缩写 */
  function spd3DowTxt(ms) {
    var d = new Date(ms).getDay();
    return SPD_L("周" + "日一二三四五六".charAt(d), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]);
  }
  /* §11.5 桶区间文案：已结束日「YYYY/M/D · 全天」；进行中日「YYYY/M/D · 00:00 –
   * 截至 HH:mm」。进行中判据 = b 被 core 钳到 now（< 自然桶末）；today 小时桶同构
   * （「YYYY/M/D HH:00 – 截至 HH:mm」/「YYYY/M/D HH:00 – HH:00」）。 */
  function spd3SlotRange(it, dayMode) {
    var d1 = new Date(it.a);
    var ymd = d1.getFullYear() + "/" + spd3P2(d1.getMonth() + 1) + "/" + spd3P2(d1.getDate());
    var hmOf = function (ms) { var d = new Date(ms); return spd3P2(d.getHours()) + ":" + spd3P2(d.getMinutes()); };
    if (dayMode) {
      var de = new Date(it.a); de.setDate(de.getDate() + 1);
      if (it.b >= de.getTime()) return ymd + SPD_L(" · 全天", " · all day");
      return ymd + SPD_L(" · 00:00 – 截至 ", " · 00:00 – until ") + hmOf(it.b);
    }
    var h0 = spd3P2(d1.getHours()) + ":00";
    if (it.b >= it.a + 36e5) return ymd + " " + h0 + " – " + hmOf(it.b);
    return ymd + " " + h0 + " – " + SPD_L("截至 ", "until ") + hmOf(it.b);
  }
  /* 槽位统一卡（v389 §13.2）：today 小时桶（柱/折线）与 week 日桶共用一个构建函数。
   * 空槽（无任何模型分量）= 轻卡「M/D（周X） · 无有效速度记录」+ §11.5 区间行；
   * 有数据 = 综合日均/均速（档位色大字）→ 模型明细（色点+名+供应商副标轻量版+均速+
   * 请求数，按 out 降序 ≤6 行 +「另有 N 个模型」）→ 有效轮次/有效输出（fmtTok/fmtCnt
   * 有则用）→ 区间 → 预估费用三态（无 fmtMoney=关闭、c=null=暂无估价、正常值，绝不
   * 显 0）。同名异供应商副标（§11.5）本文件轻量内联（view 分片 spd3ModelLabel 跨片
   * 太远）：同 name 挂多个不同 key 时名称后附 pid 尾段小字，title 恒完整 pid/model。 */
  function spd3SlotCardHTML(it, o, hoverIdx, dayMode) {
    var tailSeg = function (s) { var parts = String(s == null ? "" : s).split("/"); return parts[parts.length - 1] || String(s); };
    var fmtTok = o && typeof o.fmtTok === "function" ? o.fmtTok : null;
    var fmtCnt = o && typeof o.fmtCnt === "function" ? o.fmtCnt : null;
    var root = '<div class="zu-sv-card zu-sv3-daycard" role="tooltip"' +
      (typeof hoverIdx === "number" && hoverIdx >= 0 ? ' data-i="' + hoverIdx + '"' : "") + ">";
    if (!it || it.empty || !(spdNum(it.v) > 0)) {
      return root + '<div class="zu-sv-crow"><b>' +
        spdEsc(spdLabel(it.a, "day", true) + SPD_L("（", " (") + spd3DowTxt(it.a) + SPD_L("）", ")") +
        SPD_L(" · 无有效速度记录", " · no rated speed records")) + "</b></div>" +
        '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("区间", "Range")) + "</span><b>" +
        spdEsc(spd3SlotRange(it, dayMode)) + "</b></div></div>";
    }
    var bd = tpsBand(it.v), vv = spdNum(it.v);
    var ms = it.models || [];
    var rows = '<div class="zu-sv-crow"><span>' + spdEsc(dayMode ? SPD_L("综合日均", "Daily avg") : SPD_L("综合均速", "Avg speed")) +
      '</span><b class="zu-sv-cval' + (bd ? " " + bd.cls : "") + ' zu-sv3-big">' +
      (vv % 1 ? vv.toFixed(1) : String(vv)) + " t/s</b></div>";
    var shown = ms.length > 6 ? ms.slice(0, 6) : ms;
    for (var j = 0; j < shown.length; j++) {
      var m = shown[j], mk = spd3ModelKey(m), dup = false;
      for (var d2 = 0; d2 < ms.length; d2++)
        if (ms[d2] && ms[d2].name === m.name && spd3ModelKey(ms[d2]) !== mk) { dup = true; break; }
      var title = m.pid ? m.pid + "/" + (m.mid || m.name) : (m.mid || m.name);
      var sub = "";
      if (dup) {
        var tail = tailSeg(m.pid);
        if (tail) sub = '<i class="zu-sv3-pidsub">' + spdEsc(SPD_L("（" + tail + "）", " (" + tail + ")")) + "</i>";
      }
      var mtps = m.tps != null && spdNum(m.tps) > 0
        ? '<i class="zu-sv3-mv">' + spdNum(m.tps).toFixed(1) + " t/s</i>"
        : '<i class="zu-sv3-mv">' + spdEsc(SPD_L("无窗口", "no timing")) + "</i>";
      var cnt = (fmtCnt ? fmtCnt(spdNum(m.n)) : String(spdNum(m.n))) + SPD_L(" 次", " req");
      rows += '<div class="zu-sv-crow zu-sv3-msub"><span></span><b class="zu-sv3-mi">' +
        '<i class="zu-sv3-mdot" style="background:' + spd3Color(mk) + '"></i>' +
        '<span class="zu-sv3-mname" title="' + spdEsc(title) + '">' + spdEsc(m.name) + sub + "</span>" + mtps +
        '<i class="zu-sv3-mt">' + spdEsc(cnt) + "</i></b></div>";
    }
    if (ms.length > shown.length) rows += '<div class="zu-sv-crow zu-sv3-msub"><span></span><b class="zu-sv3-more">' +
      spdEsc(SPD_L("另有 " + (ms.length - shown.length) + " 个模型", (ms.length - shown.length) + " more models")) + "</b></div>";
    var turns = spdNum(it.turns);
    var cost;
    if (!o || !o.fmtMoney) cost = '<span class="zu-sv-off">' + spdEsc(SPD_L("费用显示已关闭", "Cost display off")) + "</span>";
    else if (it.c === null || it.c === undefined) cost = '<span class="zu-sv-off">' + spdEsc(SPD_L("暂无估价", "Estimate unavailable")) + "</span>";
    else cost = spdEsc(o.fmtMoney(it.c)) + (!it.costFull ? '<i class="zu-sv-partial">' + spdEsc(SPD_L(" · 含兜底估价", " · partly estimated")) + "</i>" : "");
    rows += '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("有效轮次", "Rated turns")) + "</span><b>" +
      spdEsc((fmtCnt ? fmtCnt(turns) : String(turns)) + SPD_L(" 轮", " turns")) + "</b></div>" +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("有效输出", "Output")) + "</span><b>" +
      spdEsc((fmtTok ? fmtTok(spdNum(it.out)) : String(spdNum(it.out))) + SPD_L(" token", " tokens")) + "</b></div>" +
      /* §15.5（v391）：生成耗时（Σ有效生成窗口；降级 ms=0 整行省略） */
      (spdNum(it.ms) > 0 ? '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("生成耗时", "Gen time")) +
        "</span><b>" + spdEsc(spd3DurTxt(it.ms)) + "</b></div>" : "") +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("区间", "Range")) + "</span><b>" +
      spdEsc(spd3SlotRange(it, dayMode)) + "</b></div>" +
      '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("预估费用", "Est. cost")) + "</span><b>" + cost + "</b></div>";
    return root + rows + "</div>";
  }
  /* ==================== ④ 柱状图槽位列构建（recent / 今天单模型共用） ====================
   * 槽位满幅（spec §11.2）：每槽 .zu-sv3-slot flex:1 1 0 均摊全宽，槽即命中区
   * （data-i/tabindex/role/aria/混合 title 契约全在槽上），柱按密度 18/14/10px 槽内
   * 水平居中。数值标签三档（spec §15.5，PRD 六轮）：估宽 estW=字符数×6px+8、槽宽
   * slotW=estPlotW/n；n≤12 全显（estW 超槽宽的非关键位让位=碰撞避让）；13–24 全试
   * 显、让位时峰值/最低/最新恒显（其余确定性隐藏）；>24 按可用空间抽样 step=
   * ceil((maxLblW+8)/slotW)（≥2，step×slotW≥maxLblW+8 保证采样位间距，不再叠加
   * fits 门槛——窄槽下叠加会全部让位、抽样失去意义），关键值恒显。
   * 悬停位恒显；其自身让位时临时隐藏左右邻已显的非关键标签（关键位恒显优先，
   * 确定性、收起即恢复）。首末柱
   * estW>slotW 时标签 align-self 钉在槽内（.zu-sv3-vpin-l/r，不越出 plot 触发横滚）。
   * 0 值柱不显 0.0（无意义读数，绝不伪造）。X 标签每槽显示，估宽 <34px 且 n>10 时
   * 隔槽显示（首/末/悬停恒显），b 兜底 ellipsis。柱色规则（spec §5）：行
   * models.length===1 → 柱色=spd3Color(模型 key)（内联 background，速度档位色阶不再
   * 上柱体）；>1 → .zu-sv3-mix 中性灰（绝不用主导模型色）+ title/aria 标「混合」；
   * =0（旧帧无 msl）→ 中性默认色。柱顶读数一位小数；最新柱（最右）latest 描边。 */
  /* estPlotW 视口感知（§15.5）：标签密度输入要贴近真实可视宽——tip=min(952,100vw−24)
   * （v387 宽度链），再减 tip border/padding 26、左卡 250（窄窗 220 取宽者保守）、
   * main gap 12、plot 左缩进 30、wrap 呼吸 10。VM/无 window 回退 SPD3_PLOT_W_EST。
   * 仅用于标签密度（数值让位、抽样步长），布局仍由 flex 自适应，不参与几何。 */
  function spd3PlotEstW() {
    var vw = 0;
    try { vw = (typeof window !== "undefined" && window.innerWidth) || 0; } catch (eW) { vw = 0; }
    if (!(vw > 0)) return SPD3_PLOT_W_EST;
    var w = Math.min(vw - 24, 952) - 26 - 250 - 12 - 30 - 10;
    return Math.max(180, Math.min(SPD3_PLOT_W_EST, w));
  }
  function spd3BarCols(items, hoverIdx, yMax) {
    var n = items.length;
    var slotW = spd3PlotEstW() / Math.max(n, 1);
    var xThin = n > 10 && slotW < 34, cols = "";
    var peakI = -1, minI = -1, maxLbl = 0;
    for (var p = 0; p < n; p++) {
      var pv = items[p].empty ? 0 : spdNum(items[p].v);
      if (pv > 0) {
        if (peakI < 0 || pv > spdNum(items[peakI].v)) peakI = p;
        if (minI < 0 || pv < spdNum(items[minI].v)) minI = p;
        maxLbl = Math.max(maxLbl, pv.toFixed(1).length * 6);
      }
    }
    /* 恒显关键位（峰/低/新）：不吃估宽让位（PRD：碰撞时优先保留） */
    var keep = {};
    keep[peakI] = true; keep[minI] = true; keep[n - 1] = true;
    var fits = function (t) { return t.length * 6 + 8 <= slotW; };
    /* n>24 抽样步长按可视宽算：step×slotW ≥ maxLblW+8 → 采样位间距保证不重叠
     * （fits 门槛只用于 step=1 的 n≤24 相邻让位；抽样位若再叠加 fits，窄槽下
     * 全部让位、抽样失去意义） */
    var step = n > 24 ? Math.max(2, Math.ceil((maxLbl + 8) / slotW)) : 1;
    /* 抑制前提=悬停位有值（空槽/0 值槽不出读数，无避让收益不出邻位抖动）且自身让位 */
    var hoverHasVal = hoverIdx >= 0 && hoverIdx < n && !items[hoverIdx].empty &&
      spdNum(items[hoverIdx].v) > 0;
    var curFits = hoverHasVal && fits(spdNum(items[hoverIdx].v).toFixed(1));
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
      /* 三档显隐（§15.5）：关键位/悬停恒显；n≤24 相邻位估宽让位、n>24 按步长抽样；
       * 悬停位自身让位时左右邻非关键标签临时隐藏（关键位恒显优先，hover 变化即重编
       * 恢复；hoverIdx=-1 不抑制） */
      var shown = !empty && vv > 0 && (isCur || keep[c] ||
        (c % step === 0 && (step > 1 || fits(txt)) &&
          !(hoverHasVal && Math.abs(c - hoverIdx) === 1 && !curFits)));
      var pinL = shown && c === 0 && !fits(txt);
      var pinR = shown && c === n - 1 && !fits(txt);
      var xShow = !xThin || c % 2 === 0 || c === n - 1 || c === hoverIdx;
      var aria = it.label + SPD_L("，", ", ") + (empty || !(vv > 0) ? SPD_L("无数据", "no data") : (vv.toFixed(1) + " t/s")) +
        (mname ? SPD_L("，", ", ") + mname : "") + (mix ? SPD_L("，", ", ") + SPD_L("混合", "mixed") : "");
      cols += '<div class="zu-sc-col' + (isCur ? " cur" : "") + (empty ? " empty" : "") +
        (c === n - 1 ? " latest" : "") + ' zu-sv3-slot" role="img" tabindex="0" data-i="' + c + '"' +
        (mix ? ' title="' + spdEsc(SPD_L("混合（" + it.models.length + " 种模型）", "Mixed (" + it.models.length + " models)")) + '"' : "") +
        ' aria-label="' + spdEsc(aria) + '">' +
        '<span class="zu-sc-vz"><span class="zu-sc-val' + (pinL ? " zu-sv3-vpin-l" : pinR ? " zu-sv3-vpin-r" : "") + '">' +
        (shown ? txt : "") + "</span>" +
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
  /* ==================== ⑤ 悬停卡（五字段 + 真实模型组成；v389 起 recent 轮卡专用） ====================
   * 结构沿 V2 spdCardHTML 纪律：时间（tv 覆写保留，缺省聚合桶区间压缩）/ 速度（档位
   * 色值）/ 模型型号 / Token 总消耗（input 已含缓存、output 已含思考，不重复相加）/
   * 预估价格（缺失显暂无估价，绝不显示 0）。「模型型号」段升级（spec §7）：多模型
   * 主行标「混合（N 种模型）」+ 逐模型子行（色点 + 名 + 该模型 t/s + 该模型 token）；
   * t/s 仅在该模型条目 ms>0 时给出（绝不拿整轮窗口冒充模型速度），无 ms 只显名称与
   * token。o={fmtTok,fmtCnt,fmtMoney}，fmtMoney 缺失按 V2 纪律显「费用显示已关闭」。
   * today/week 槽位卡自 v389 起改走 spd3SlotCardHTML（§13.2 增强字段 + 空槽轻卡），
   * 本函数保留给 recent 一轮一柱形态。hoverIdx 可选：≥0 时卡根携带 data-i（Portal
   * 定位与键盘焦点归位消费）。 */
  /* 生成耗时文本（§15.5 hover 六要素）：ms→人读时长，中文值与单位紧邻（v125 口径）、
   * 英文值与单位紧邻+时段间空格；秒 <60 一位小数，向上分段零段省略；ms≤0 空串
   * （调用点整行省略，绝不显示 0）。 */
  function spd3DurTxt(ms) {
    if (!(spdNum(ms) > 0)) return "";
    if (ms < 100) return SPD_L("<0.1秒", "<0.1s");   /* 绝不显示 0.0（v391 审查 MINOR-3） */
    var tot = Math.round(ms / 1000);
    var h = Math.floor(tot / 3600), mnt = Math.floor((tot % 3600) / 60), sec = tot % 60;
    if (tot < 60) return (ms / 1000).toFixed(1) + SPD_L("秒", "s");
    var zh = (h ? h + "时" : "") + (mnt ? mnt + "分" : "") + (sec ? sec + "秒" : "");
    var en = (h ? h + " h " : "") + (mnt ? mnt + " m " : "") + (sec ? sec + " s" : "");
    return SPD_L(zh, en.replace(/\s+$/, ""));
  }
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
      /* §15.5（v391）：生成耗时行（Σ有效生成窗口；降级帧 ms=0 整行省略，绝不造 0）——
       * 时间/模型/速度/Token/耗时/费用六要素齐 */
      (spdNum(item.ms) > 0 ? '<div class="zu-sv-crow"><span>' + spdEsc(SPD_L("生成耗时", "Gen time")) +
        '</span><b>' + spdEsc(spd3DurTxt(item.ms)) + "</b></div>" : "") +
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
      /* §13.6 head sub 覆盖提示：非空桶数 < 轴长时「有效 X 个小时」（聚焦档全实桶
       * 不添噪）；槽位卡走统一构建器（空槽轻卡，§13.2） */
      var filled = 0;
      for (var f = 0; f < n; f++) if (!items[f].empty) filled++;
      var sub = filled < n ? SPD_L("有效 " + filled + " 个小时", filled + " hours with data") : "";
      SPD_PORTAL = spd3PortalFor(items, hoverIdx, o, false);
      return SPD3_CHART_CSS +
        '<div class="zu-speed-chart zu-sv3-chart">' + (spd3ChartHeadHTML(an, sub) || "") +
        spd3BarsFrame(gt, n, spd3BarCols(items, hoverIdx, tk.yMax)) + "</div>";
    }
    return spd3LineHTML(an, hoverIdx, o, items, head, false);
  }
  /* ==================== ⑨ 折线图共用（今天多模型 / 近 7 天） ====================
   * 满幅（spec §11.2 + v389 §13.1）：svg width/height 均 100%、无 viewBox，x/y 全
   * 百分比（线宽/圆点半径恒 px 不失真）。y % 换算公式：yPct(v) = 2 + (1 − v/yMax) × 98
   * （顶部留 2% 余量：v=yMax → 2%，v=0 → 100% 基线），3 位小数；值区 svg 高 =
   * plot − 16px X 带（X 标签在 plot 内下方独立 xsvg，text y=11px、x 仍百分比，恒贴
   * plot 底）。每系列一组分段 <line>（相邻非空点一连，缺口断线不插值：null 即断段）；
   * 数据点 circle r=2.5 只落真实点。命中列 rect（data-i=桶序号，x/width/height 均 %）
   * 承载悬停/键盘，同组内竖线十字参考线由 CSS :hover/:focus-within 显现；折线 g
   * （.zu-sv3-lineg，线+点同组、data-m=模型键）画在命中列之上，pointer-events:stroke
   * 纯 CSS 线级高亮（两级 hover：列级卡=06/01 委托既有 + 线级视觉）。Y 轴刻度/网格
   * 走 HTML gutter/grid（值区高，横线 bottom:%），与柱图同构。端数值标签仅单模型
   * 绘制（每线一枚=末个非空点，PRD 10.2 每线仅端标签；v388 §12.5 起 today/week 多
   * 模型 perModel>1 默认不画——多线右缘堆叠实测重叠，全模型数值经悬停十字卡），
   * 上下错开 ≥6%（y 已百分比化：6%≈12px@200px 值区、11~17px@弹性值区 184..284，
   * 3px 基线微调走 dy）；weekForm 近 7 天附加中性虚线「总体」与单模型分段面积
   * （嵌套 svg viewBox 0..100 百分比坐标、基线 y=100，纯填充拉伸不失真）——spec §5
   * 的总体线是 week 多模型专属。 */
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
    /* 百分比几何（保留 3 位小数）：槽中心 / hit 列 / 数据 y 全部随 100% 宽高自适应 */
    var pc = function (x) { return Math.round(x * 1000) / 1000; };
    var xc = function (i) { return pc((i + 0.5) * 100 / N); };
    /* 系列组装：多模型（msAvail）=逐模型线 + 总体虚线（an.overall 在场才画）；
     * 其余（单模型 / 降级多模型）=一条桶整值线（单模型上模型色，降级中性灰）。
     * mkey=模型身份键（线级 data-m 消费；总体虚线/降级混合线无单一身份不携带） */
    var series = [];
    var multi = an.perModel && an.perModel.length > 1;
    if (multi && an.msAvail) {
      for (var s = 0; s < an.perModel.length; s++) {
        var pm = an.perModel[s];
        series.push({ color: spd3Color(pm.key), dashed: false, mkey: pm.key, pts: spd3SeriesPts(slots, pm.key) });
      }
      if (weekForm && an.overall) series.push({ color: "", dashed: true, mkey: "", pts: spd3SeriesPts(slots, null) });
    } else {
      var soloKey = !multi && an.perModel && an.perModel.length === 1 ? an.perModel[0].key : "";
      series.push({ color: soloKey ? spd3Color(soloKey) : "", dashed: false, mkey: soloKey, pts: spd3SeriesPts(slots, null) });
    }
    var maxV = 0;
    for (var m2 = 0; m2 < series.length; m2++) {
      var pp = series[m2].pts;
      for (var q = 0; q < pp.length; q++) if (pp[q] != null && pp[q] > maxV) maxV = pp[q];
    }
    if (!(maxV > 0)) return spd3ChartEmptyHTML(head);
    var tk = spd3Ticks(maxV), gt = spd3GridTicks(tk);
    /* v389 §13.1 y 百分比化：yPct(v) = 2 + (1 − v/yMax) × 98（顶部余量 2%：
     * v=yMax → 2%、v=0 → 100% 基线），3 位小数 */
    var yPct = function (v) { return pc(2 + (1 - v / tk.yMax) * 98); };
    var xtxt = "", areas = "", lineGs = "", labelTxt = "", labels = [];
    /* X 轴标签（独立 xsvg 带）：week 恒 7 日；today 隔 3 小时（00/03/06…）+ 末槽恒显
     * （spec §11.2）；非 HH:MM 标签按显处理（防御未知粒度） */
    for (var xi = 0; xi < slots.length; xi++) {
      var lb2 = (slots[xi] && slots[xi].label) || "";
      var hm = /^(\d{1,2}):/.exec(lb2);
      if (!(weekForm || !hm || xi === slots.length - 1 || Number(hm[1]) % 3 === 0)) continue;
      xtxt += '<text class="zu-sv3-xtxt" x="' + xc(xi) + '%" y="11">' + spdEsc(lb2) + "</text>";
    }
    for (var si = 0; si < series.length; si++) {
      var srs = series[si], segs = "", segOpen = false, sx = 0, sy = 0, dots = "";
      for (var i3 = 0; i3 < srs.pts.length; i3++) {
        if (srs.pts[i3] == null) { segOpen = false; continue; }
        var nx = xc(i3), ny = yPct(srs.pts[i3]);
        if (segOpen) segs += '<line x1="' + sx + '%" y1="' + sy + '%" x2="' + nx + '%" y2="' + ny + '%"/>';
        sx = nx; sy = ny; segOpen = true;
      }
      /* 近 7 天单模型实线：分段面积（模型色 12% 透明度，缺口不填充）；面积载体是
       * 嵌套 svg（viewBox 0..100 百分比坐标、preserveAspectRatio=none，纯填充无描边，
       * 拉伸不失真，基线 y=100）。v384 S6-MINOR5：多模型周视图纯折线+虚线总体
       * （设计稿无面积） */
      if (weekForm && !srs.dashed && srs.color && !multi) {
        var area = "", seg2 = false, segStart = 0;
        for (var i4 = 0; i4 <= srs.pts.length; i4++) {
          var pv2 = i4 < srs.pts.length ? srs.pts[i4] : null;
          if (pv2 == null) {
            if (seg2) {
              area += " L " + xc(i4 - 1) + " 100 L " + xc(segStart) + " 100 Z";
              seg2 = false;
            }
            continue;
          }
          if (!seg2) {
            area += (area ? " M " : "M ") + xc(i4) + " 100 L " + xc(i4) + " " + yPct(pv2);
            segStart = i4; seg2 = true;
          } else area += " L " + xc(i4) + " " + yPct(pv2);
        }
        if (area) areas += '<path class="zu-sv3-area" fill="' + srs.color + '" d="' + area + '"/>';
      }
      /* 数据点：只落真实点（虚线总体不加点）；r 恒 px，cy 随值区百分比 */
      if (!srs.dashed) for (var i5 = 0; i5 < srs.pts.length; i5++) if (srs.pts[i5] != null)
        dots += '<circle class="zu-sv3-pt' + (srs.color ? "" : " zu-sv3-npt") + '" cx="' + xc(i5) +
          '%" cy="' + yPct(srs.pts[i5]) + '%" r="2.5"' + (srs.color ? ' fill="' + srs.color + '"' : "") + "/>";
      /* 线级 g（v389 §13.2）：线+点同组（data-m=模型键），画在命中列上层，
       * pointer-events:stroke 纯 CSS hover 高亮（两级 hover 见 SPD3_CHART_CSS 注释） */
      if (segs || dots) lineGs += '<g class="zu-sv3-lineg zu-sv3-line' + (srs.color ? "" : " zu-sv3-nline") +
        (srs.dashed ? " zu-sv3-oline" : "") + '"' + (srs.mkey ? ' data-m="' + spdEsc(srs.mkey) + '"' : "") +
        (srs.color ? ' stroke="' + srs.color + '"' : "") + ">" + segs + dots + "</g>";
      /* 端数值标签：仅单模型（单线）每线一枚（末个非空点）；多模型（perModel>1，
       * today/week 同款）默认不画——多线右缘堆叠实测重叠（spec §12.5 / PRD 10.2/9.4），
       * 数值经悬停十字卡与数据点承载。降级多模型（msAvail=false 单中性线）同样跳过，
       * 判据恒为 perModel>1 */
      if (!multi) for (var i6 = srs.pts.length - 1; i6 >= 0; i6--) if (srs.pts[i6] != null) {
        labels.push({ y0: yPct(srs.pts[i6]), text: srs.pts[i6].toFixed(1), color: srs.color, dim: srs.dashed || !srs.color });
        break;
      }
    }
    /* 端标签上下错开 ≥6%（y 百分比化后的间距口径：≈12px@200px 值区、随弹性值区
     * 11~17px）：先向下推，越底再从末尾回推（全部钳在 [2,97]%；3px 基线微调走 dy
     * 不参与避让） */
    labels.sort(function (a, b) { return a.y0 - b.y0; });
    var maxY = 97;
    for (var e1 = 1; e1 < labels.length; e1++) if (labels[e1].y0 - labels[e1 - 1].y0 < 6) labels[e1].y0 = labels[e1 - 1].y0 + 6;
    if (labels.length && labels[labels.length - 1].y0 > maxY) {
      labels[labels.length - 1].y0 = maxY;
      for (var e2 = labels.length - 2; e2 >= 0; e2--) if (labels[e2 + 1].y0 - labels[e2].y0 < 6) labels[e2].y0 = labels[e2 + 1].y0 - 6;
    }
    for (var e3 = 0; e3 < labels.length; e3++) {
      var lb3 = labels[e3];
      labelTxt += '<text class="zu-sv3-elabel' + (lb3.dim ? " zu-sv3-olabel" : "") + '" x="99.2%" y="' +
        pc(lb3.y0) + '%" dy="3"' + (lb3.color ? ' fill="' + lb3.color + '"' : "") + ">" + lb3.text + "</text>";
    }
    /* 命中列（x/width/height 均 %）+ 同组十字参考线（CSS :hover/:focus-within 显现，
     * 零 JS 监听）；折线 g 在命中列之后绘制（上层）承担线级 hover（见 CSS 注释） */
    var hits = "";
    for (var hi = 0; hi < slots.length; hi++) {
      hits += '<g class="zu-sv3-hg"><line class="zu-sv3-xline" x1="' + xc(hi) + '%" x2="' + xc(hi) +
        '%" y1="0" y2="100%"/>' +
        '<rect class="zu-sv3-hit" data-i="' + hi + '" x="' + pc(hi * 100 / N) + '%" y="0" width="' +
        pc(100 / N) + '%" height="100%" tabindex="0" role="img" aria-label="' +
        spdEsc(spd3HitAria(an, slots[hi])) + '"/></g>';
    }
    SPD_PORTAL = spd3PortalFor(slots, hoverIdx, o, weekForm);
    return SPD3_CHART_CSS +
      '<div class="zu-speed-chart zu-sv3-chart">' + (head || "") +
      '<div class="zu-sc-wrap" data-sv-end="1"><div class="zu-sc-plot">' +
      '<span class="zu-sc-grid">' + gt.grid + '</span>' +
      '<span class="zu-sc-gutter">' + gt.gutter + '</span>' +
      '<svg class="zu-sv3-svg" width="100%" height="100%">' +
      (areas ? '<svg class="zu-sv3-asvg" width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">' + areas + "</svg>" : "") +
      hits + '<g class="zu-sv3-lines">' + lineGs + "</g>" + labelTxt + "</svg>" +
      '<svg class="zu-sv3-xsvg" width="100%" height="' + SPD3_X_H + '">' + xtxt + "</svg>" +
      "</div></div></div>";
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
      /* 空槽 b 与 full 同源钳 now：今天空槽 b<日末=进行中日（§11.5 区间/轻卡判据），
       * 过去空槽=整日已结束。 */
      if (!it2) it2 = { v: null, empty: true, label: spdLabel(t0, "day", true),
        full: spdFull(t0) + " – " + spdFull(Math.min(t0 + 864e5, nowMs) - 1),
        a: t0, b: Math.min(t0 + 864e5, nowMs), models: [] };
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
    var sub = filled < 7 ? SPD_L("有效 " + filled + "/7 天", filled + "/7 days with data") : "";
    /* v392（spec §16，用户裁定 2026-11-18）：单模型恒柱状（与 today 单模型对称）——
     * 恒折线在单有效日时退化为孤立点（真机反馈：近 7 天无柱状图）；7 日槽位空日=空位
     * 不显 0。多模型保留折线+面积+总体虚线（spec §5 week 形态的多模型专属设计）。 */
    if (an.perModel && an.perModel.length === 1) {
      var maxV = spd3RealMax(slots);
      if (!slots.length || !(maxV > 0)) return spd3ChartEmptyHTML(spd3ChartHeadHTML(an, sub) || "");
      var tk = spd3Ticks(maxV), gt = spd3GridTicks(tk);
      SPD_PORTAL = spd3PortalFor(slots, hoverIdx, o, false);
      return SPD3_CHART_CSS +
        '<div class="zu-speed-chart zu-sv3-chart">' + (spd3ChartHeadHTML(an, sub) || "") +
        spd3BarsFrame(gt, slots.length, spd3BarCols(slots, hoverIdx, tk.yMax)) + "</div>";
    }
    var head = spd3ChartHeadHTML(an, sub) || "";
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
