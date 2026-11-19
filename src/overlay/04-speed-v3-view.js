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
   * 集成契约：spd3LeftHTML 第三参 expanded（多模型分布表展开态，调用方传布尔）、第四参
   * poolSingle（chips 池恰一模型=「真单模型池」，驱动「当前模型」行去重；v390 用户
   * 裁定「唯一模型」徽标与供应商副标 .zu-sv3-msub/.zu-sv3-only 均去除）；
   * 筛选 chips 池缺省取 an.perModel+an.selMissing，
   * 筛选激活时集成方应传 ctx.pool=未筛选全量模型（否则 chips 收缩为已选集，无法点回）。
   * v387 实机修复批（spec §11）：宽度链 border-box 释放（§11.1）；多模型态主数字恒在
   * （§11.3）；an.real 空时图表区渲染居中空态 spd3EmptyStateHTML（§11.4，占位 <!--CHART-->
   * 在本文件内被替换、wire 的 replace 自然落空）；计数行统一「已选 X/Y · 本期有效 N」、
   * live 徽标估算态固定文案、同名异供应商副标 spd3ModelLabel、标题 SVG（§11.5）。
   * v388 自适应批（spec §12）：root 高度改离散档位 spd3HeightTier（内联 min-height +
   * data-h-tier，§12.1）；左卡内容自然流（stats 分隔线替代 margin-top:auto 推底，
   * 真单模型池「当前模型」行去重为「有效输出」（值经 o.fmtTok，缺席整行省略），§12.2）；
   * 多模型分布表 table→div Grid 三列（minmax(0,1fr) 64px 44px，根除 23px 横向溢出，
   * msAvail=false 两列变体，§12.2）；筛选栏恒单行（fbar/chips nowrap + overflow:hidden，
   * 常驻 chips 预算 6→3，§12.4）。
   * v389 自适应批（spec §13.5）：stats 恢复 margin-top:auto Footer 语义（推翻 §12.2
   * 「禁 auto」——第三轮断层实为分布表缺失时的推底空腔，Grid 化后左卡内容密度已
   * 足够），卡 padding-bottom ≥12 保呼吸；分布条 role=img + aria-label + 段级 title
   * （名 · 请求数 · 占比）；dist-h/dbar/dwrap 三容器零水平 margin/padding 锁对齐。
   * v390 批（spec §14.1/§14.2）：筛选入口统一——.zu-sv3-fsearch（含 SPD3_SVG_SEARCH）
   * 整链退役，弹出层入口=「模型筛选」标签与 +N 两枚 data-sv3-fopen 真 button
   * （aria-haspopup/aria-expanded 随 pop.open）；fpop 锚定筛选栏正下方（默认 87px、
   * 打开时按 fbar 实测底缘内联覆写）、
   * 宽 340px、bottom 废除；dbar 轨道契约——min-width:2px 废除、段宽=真实 share、
   * Σ段宽恒 100%，Top6+「其他」聚合段（宽按原始 n 计数差），极小占比显 <0.1%
   * 不显 0%，dbar aria 简化为「模型分布：N 个模型」（完整数据由下方表格承载）。 */
  /* SPD_V3_VIEW_BEGIN */
  var SPD3_SVG_FUNNEL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z"/></svg>';
  var SPD3_SVG_CUBE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>';
  /* v387 §11.5：标题 📈 emoji 换自包含 SVG（16×16 轴+折线，stroke currentColor 随主题） */
  var SPD3_SVG_TREND = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4v16h18"/><path d="m7 14 4-5 3 3 5-7"/></svg>';
  /* 数值格式沿用 V2 口径：整数直显、小数留 1 位、空值 em dash（绝不显 0 t/s） */
  function spd3FmtV(x) { return x == null ? "—" : (x % 1 ? x.toFixed(1) : String(x)); }
  /* §14.2 占比文本：share<0.001（即 <0.1%）显「<0.1%」不显 0%——分布表占比列与
   * dbar 段 title 共用本函数，两处口径同步；段/列宽仍用原始 share，不做显示值放大 */
  function spd3PctTxt(share) {
    var p = Math.max(0, (share || 0) * 100);
    return p < 0.1 ? SPD_L("<0.1%", "<0.1%") : String(Math.round(p * 10) / 10) + "%";
  }
  /* 色点 + 名称（单模型态模型行专用；chips/弹层/分布行走 spd3ModelLabel——同名异
   * 供应商需要副标）。超长 ellipsis，全文走 title */
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
  /* v387 §11.5 同名不同供应商（同 name 异 key 不合并身份）：显示名后追加供应商副标。
   * spd3Parts(entry) = {pid, mid}：entry 自带 pid/mid（spd3 解包产物）优先，缺席按
   * 身份键切段兜底（chips 池条目只有 key/name）；title 恒为完整 pid/model（pid 空只显
   * model 段，退化名键无供应商信息不硬造）。spd3TailSeg = 「/」末段（provider id 常是
   * 长路径，尾段才有辨识度），空串兜底原串。 */
  function spd3TailSeg(s) {
    var parts = String(s == null ? "" : s).split("/");
    return parts[parts.length - 1] || String(s);
  }
  function spd3Parts(entry) {
    var key = spd3ModelKey(entry);
    var cut = key.indexOf("\x1f");
    var kpid = cut >= 0 ? key.slice(0, cut) : "";
    var kmid = cut >= 0 ? key.slice(cut + 1) : key;
    return { pid: (entry && entry.pid) || kpid, mid: (entry && entry.mid) || kmid || (entry && entry.name) || "" };
  }
  function spd3ModelTitle(entry) {
    var p = spd3Parts(entry);
    return p.pid ? p.pid + "/" + p.mid : p.mid;
  }
  /* chips/弹层/分布行共用：色点 + 名称（v390 用户裁定去除供应商副标 .zu-sv3-msub；
   * 同名异供应商的区分保留在 title/hover 完整身份 = provider/model） */
  function spd3ModelLabel(entry, allEntries) {
    var key = spd3ModelKey(entry);
    var name = (entry && entry.name) || spd3KeyName(key);
    return '<i class="zu-sv3-dot" style="background:' + spd3Color(key) + '" aria-hidden="true"></i>' +
      '<span class="zu-sv3-chip-name">' + spdEsc(name) + "</span>";
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
    return '<div class="zu-sv-head"><div class="zu-sv-title">' + SPD3_SVG_TREND +
      "<span>" + spdEsc(SPD_L("生成速度", "Generation speed")) + "</span></div>" +
      '<div class="zu-sv-filter"><span class="zu-sv-flabel">' + spdEsc(SPD_L("范围", "Scope")) + "</span>" +
      spd3TabRow("range", SPD_RANGES, an.range, rl) +
      '<span class="zu-sv-time"><span class="zu-sv-flabel">' + spdEsc(SPD_L("时间", "Time")) + "</span>" +
      spd3TabRow("period", SPD_PERIODS, an.period, pl) + "</span></div></div>";
  }
  /* ==================== ② 筛选条（spec §3/§14.1）：漏斗 + 入口按钮 + chips + 计数 ====================
   * pool = [{key,name,n?,missing?}]（spd3ChipPool 产出）；o = {selMissing?, pop?, active?}。
   * 选中态 = filt.mode==="sel" 且含该 key；无数据模型（missing / o.selMissing 命中，
   * 含 pool 外的 selMissing key 兜底补一枚）加 .zu-sv3-chip-empty + 「无数据」标记。
   * ≤3 枚全显、超出收 +N（§12.4 常驻预算降为 3，fbar 恒单行）；pool 为空不渲染整条。
   * §14.1 入口统一（方案 A）：旧右侧放大镜按钮（.zu-sv3-fsearch）整链退役；弹出层
   * 入口 = 「模型筛选」标签 button 与「+N」button（同挂 data-sv3-fopen，
   * aria-haspopup="dialog"、aria-expanded 随 o.pop.open），同一面板/同一状态/同一关闭行为。
   * 计数行（v387 §11.5 三语义统一）：已选 X/Y · 本期有效 N —— X=显式筛选键数（auto=X=Y）、
   * Y=池模型数、N=o.active=本期有效模型数（an.perModel.length，调用方传入）。 */
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
    var chips = "", MAX = 3, onCount = 0;
    for (i = 0; i < rows.length && i < MAX; i++) {
      var p = rows[i], on = isOn(p.key), empty = !!p.missing || miss.indexOf(p.key) >= 0;
      if (on) onCount++;
      chips += '<button type="button" class="zu-sv3-chip' + (on ? " on" : "") + (empty ? " zu-sv3-chip-empty" : "") +
        '" data-k="' + spdEsc(p.key) + '"' + (on ? ' aria-pressed="true"' : ' aria-pressed="false"') +
        ' title="' + spdEsc(spd3ModelTitle(p)) + '" aria-label="' + spdEsc(p.name + (empty ? SPD_L("（无数据）", " (no data)") : "")) + '">' +
        spd3ModelLabel(p, rows) +
        (empty ? '<em class="zu-sv3-chip-miss">' + spdEsc(SPD_L("无数据", "no data")) + "</em>" : "") + "</button>";
    }
    var hidden = rows.length - Math.min(rows.length, MAX);
    /* §14.1：弹出层打开态驱动两处入口按钮的 aria-expanded */
    var popOpen = !!(o.pop && o.pop.open);
    if (hidden > 0) chips += '<button type="button" class="zu-sv3-chip-more" data-sv3-fopen' +
      ' aria-haspopup="dialog" aria-expanded="' + (popOpen ? "true" : "false") + '" title="' +
      spdEsc(SPD_L("其余 " + hidden + " 个模型，可搜索查看", hidden + " more models — use search")) +
      '" aria-label="' + spdEsc(SPD_L("还有 " + hidden + " 个未展示模型，点击查看和筛选",
        hidden + " more models not shown, click to view and filter")) + '">+' + hidden + "</button>";
    var selX = filt && filt.mode === "sel" && filt.keys ? filt.keys.length : rows.length;
    var act = typeof o.active === "number" ? o.active : 0;
    var count = SPD_L("已选 " + selX + "/" + rows.length + " · 本期有效 " + act,
      "Selected " + selX + "/" + rows.length + " · " + act + " active");
    return '<div class="zu-sv3-fbar"><span class="zu-sv3-fico">' + SPD3_SVG_FUNNEL + "</span>" +
      /* §14.1：「模型筛选」标签为真 button（弹出层入口之一，data-sv3-fopen） */
      '<button type="button" class="zu-sv3-flabel" data-sv3-fopen aria-haspopup="dialog" aria-expanded="' +
      (popOpen ? "true" : "false") + '">' + spdEsc(SPD_L("模型筛选", "Model filter")) + "</button>" +
      '<div class="zu-sv3-chips">' + chips + "</div>" +
      '<span class="zu-sv3-fcount">' + spdEsc(count) + "</span></div>";
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
        (on ? ' aria-pressed="true"' : ' aria-pressed="false"') + ' title="' + spdEsc(spd3ModelTitle(r)) + '">' +
        spd3ModelLabel(r, rows) +
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
  /* ==================== ④ 左摘要卡（spec §6 + §11.3/§11.4/§11.5/§15.1） ====================
   * 三态：空（无 perModel 或无 overall）→ 主数字 — + 请求轮次 0/有效模型 0 + 峰最低新 —；
   * 单模型（perModel 恰 1，无数据模型不计）→ 主数字/档位/模型行/请求轮次/有效输出
   * （或当前模型）；多模型 → 主数字恒在（v387 §11.3：任何模型数不缺均速大数字）→
   * 档位胶囊 → 「本期有效 N 个模型 · M 轮」（selMissing 非空追加无有效记录提示）→ 分布
   * （堆叠条 + div Grid 网格表默认 ≤4 行，data-sv3-more 查看全部；表容器 max-height
   * 内滚，展开态不撑高主卡）→ 峰/低/新。分布行序按 share（请求数占比）降序；
   * msAvail=false 降级：隐藏「均速」列（.zu-sv3-dtab-noms 两列变体），绝不出现 t/s 假值。
   * poolSingle = chips 池恰 1 个真模型——驱动「当前模型」行去重（v390 起「唯一模型」
   * 徽标已按用户裁定去除）；筛选缩到单模型不冒充。「本期统计」组标题与「覆盖范围」
   * kv 已随 v391 §15.1 删除（范围语义由标题行承载）。 */
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
  /* 主数字构建函数（§11.3 单/多/空三态共用同一结构）：overall.v 档位色 + t/s 单位，
   * v 缺席显 — 绝不造 0 t/s */
  function spd3MainNumHTML(v) {
    var bd = v != null ? tpsBand(v) : null;
    return '<div class="zu-sv3-main-num"><span class="' + (bd ? bd.cls : "dim") + '">' + spdEsc(spd3FmtV(v)) +
      '</span><span class="zu-sv3-unit">t/s</span></div>';
  }
  function spd3LeftHTML(an, live, expanded, poolSingle, fmtTok) {
    an = an || {};
    var overall = an.overall || null;
    var models = an.perModel || [];
    var bd = overall ? tpsBand(overall.v) : null;
    var dayLbl = an.unit === "day";
    /* live 徽标（§11.5）：估算态固定「实时估算中」（历史均速含义不被污染），
     * 非估算实时态（思考/工具）statusText 透传不变 */
    var liveTxt = live ? (live.speedIsEstimated ? SPD_L("实时估算中", "live estimate") : (live.statusText || "")) : "";
    var headRow = '<div class="zu-sv3-title-row"><span class="zu-sv3-ltitle">' + spdEsc(spd3LeftTitle(an)) + "</span>" +
      (liveTxt ? '<span class="zu-sv3-sub">' + spdEsc(liveTxt) + "</span>" : "") + "</div>";
    var stats = '<div class="zu-sv3-stats">' +
      spd3StatHTML(SPD_L("峰值", "Peak"), an.peak, dayLbl ? SPD_L("最高日均", "Best daily") : "") +
      spd3StatHTML(SPD_L("最低", "Low"), an.low, dayLbl ? SPD_L("最低日均", "Worst daily") : "") +
      spd3StatHTML(SPD_L("最新", "Latest"), an.latest, dayLbl ? SPD_L("最近日均", "Latest daily") : "") + "</div>";
    if (!models.length || !overall) {
      /* 空池/显式空筛选（§11.4）：标题 + — 主数字 + 请求轮次 0 / 有效模型 0 +
       * 峰最低新 —，绝不造 0 t/s；图表区由 spd3CardHTML 换居中空态块 */
      return '<div class="zu-sv3-left">' + headRow + spd3MainNumHTML(null) +
        '<div class="zu-sv3-kv"><i>' + spdEsc(SPD_L("请求轮次", "Turns")) + "</i><b>" +
        spdEsc(spdNum(0) + SPD_L("轮", " turns")) + "</b></div>" +
        '<div class="zu-sv3-kv"><i>' + spdEsc(SPD_L("有效模型", "Active models")) + "</i><b>0</b></div>" +
        stats + "</div>";
    }
    if (models.length === 1) {
      var m = models[0];
      /* §15.1：「本期统计」组标题与「覆盖范围」kv 删除（v391）——范围语义由标题行
       * （「最近 N 轮平均速度」等）承载，kv 组紧凑直达数据 */
      /* §12.2 当前模型行去重：真单模型池（poolSingle）时本行与模型行 Chip 恒完全同名
       * （同一 perModel 条目），替换为「有效输出」（overall.out 经 o.fmtTok 格式化）；
       * fmtTok 缺席整行省略（不虚构格式化值），非真单模型池（筛选缩到单模型）保留原名 */
      var modelKv = "";
      if (poolSingle && typeof fmtTok === "function") {
        modelKv = '<div class="zu-sv3-kv"><i>' + spdEsc(SPD_L("有效输出", "Effective output")) + "</i><b>" +
          spdEsc(String(fmtTok(overall.out))) + "</b></div>";
      } else if (!poolSingle) {
        modelKv = '<div class="zu-sv3-kv"><i>' + spdEsc(SPD_L("当前模型", "Model")) + '</i><b title="' + spdEsc(m.name) + '">' +
          spdEsc(m.name) + "</b></div>";
      }
      return '<div class="zu-sv3-left">' + headRow + spd3MainNumHTML(overall.v) +
        (bd ? spd3BandHTML(bd) : "") +
        '<div class="zu-sv3-model">' + spd3DotAndName(m.key, m.name) + "</div>" +
        '<div class="zu-sv3-kv"><i>' + spdEsc(SPD_L("请求轮次", "Turns")) + "</i><b>" +
        spdEsc(spdNum(overall.turns) + SPD_L("轮", " turns")) + "</b></div>" +
        modelKv +
        stats + "</div>";
    }
    /* ---- 多模型态（§11.3）：标题 → 主数字 → 档位胶囊 → 本期有效计数 →
     * 分布（堆叠条+网格表，默认 ≤4 行）→ 峰最低最新 ---- */
    /* §14.2 分布条（Top6+其他）：条=概况——shareSorted 前 6 段直出，其余模型聚合为
     * 单段中性灰「其他」（段数 ≤7 无碎片）；表=明细——真实模型全量展开（DEF_ROWS
     * 折叠，见下），两处口径有意不同。width 恒按真实 share（轨道契约见样式注释）。
     * 「其他」宽严格按原始 n 计数差（otherN=Σn(全部)−Σn(前 6)、otherW=otherN/totalN），
     * 不用四舍五入后的显示百分比相加补差——逐段取整再凑和会累积漂移，数据级和恒为 1。
     * 段 title=名 · 请求数 · 占比（请求数用 spdNum 原值——本分片无 fmtCnt；占比文本与
     * 表列共用 spd3PctTxt，极小占比显 <0.1% 不显 0%）。dbar aria 简化为概况
     * （PRD 6.7：完整数据由下方表格承载），段 title 保留。 */
    var shareSorted = models.slice().sort(function (a, b) { return (b.share || 0) - (a.share || 0); });
    var turns = spdNum(overall.turns);
    var TOP_SEGS = 6, totalN = 0, tni;
    for (tni = 0; tni < models.length; tni++) totalN += models[tni].n || 0;
    var bar = "";
    for (var bi = 0; bi < shareSorted.length && bi < TOP_SEGS; bi++) {
      var bm = shareSorted[bi];
      var bName = bm.name || spd3KeyName(bm.key);
      var bPct = Math.max(0, (bm.share || 0) * 100);
      bar += '<i style="background:' + spd3Color(bm.key) + ";width:" + bPct +
        '%" title="' + spdEsc(bName + " · " + spdNum(bm.n) +
          SPD_L(" 次请求", " requests") + " · " + spd3PctTxt(bm.share)) + '"></i>';
    }
    if (shareSorted.length > TOP_SEGS) {
      var topN = 0, oni;
      for (oni = 0; oni < TOP_SEGS; oni++) topN += shareSorted[oni].n || 0;
      var otherN = Math.max(0, totalN - topN);
      var otherW = totalN > 0 ? otherN / totalN : 0;
      var otherPct = spd3PctTxt(otherW), otherCnt = shareSorted.length - TOP_SEGS;
      bar += '<i style="background:var(--color-tooltip-tag-foreground,#a6a6a6);width:' + (otherW * 100) +
        '%" title="' + spdEsc(SPD_L(
          "其他 " + otherCnt + " 个模型 · " + spdNum(otherN) + " 次请求 · " + otherPct,
          "Other " + otherCnt + " models · " + spdNum(otherN) + " requests · " + otherPct)) + '"></i>';
    }
    var msAvail = an.msAvail !== false;
    /* §12.2 分布表 div Grid：三列 minmax(0,1fr) 64px 44px（名称可收缩+ellipsis →
     * 行恒不溢出，根除旧 table 23px 横向溢出；行/容器不写 overflow-x）；msAvail=false
     * 两列变体（.zu-sv3-dtab-noms 去均速列）。表头行同 grid。 */
    /* v388 审查 M1：div 化后补 ARIA 表语义（role=table 需 row/cell 子级，否则 AT
     * 读到零行空表）；列数随 msAvail 变，role 结构同步 */
    var thead = '<div class="zu-sv3-drow" role="row"><span class="zu-sv3-dcell" role="columnheader">' + spdEsc(SPD_L("模型", "Model")) + "</span>" +
      (msAvail ? '<span class="zu-sv3-dcell zu-sv3-dnum" role="columnheader">' + spdEsc(SPD_L("均速", "Avg speed")) + "</span>" : "") +
      '<span class="zu-sv3-dcell zu-sv3-dnum" role="columnheader">' + spdEsc(SPD_L("占比", "Share")) + "</span></div>";
    /* DEF_ROWS=4（§11.3）：表=真实模型全量展开的折叠窗，「其他」聚合段不入明细表
     * （仅 dbar 条聚合，spec §14.2）——表与条口径有意不同 */
    var DEF_ROWS = 4;   /* 默认 ≤4 行，data-sv3-more 查看全部（展开态内滚不撑高） */
    var shown = expanded ? shareSorted : shareSorted.slice(0, DEF_ROWS);
    var rowsHtml = "";
    for (var ri = 0; ri < shown.length; ri++) {
      var rm = shown[ri];
      rowsHtml += '<div class="zu-sv3-drow" role="row"><span class="zu-sv3-dcell zu-sv3-dname" role="cell" title="' + spdEsc(spd3ModelTitle(rm)) + '">' +
        spd3ModelLabel(rm, shareSorted) + "</span>" +
        (msAvail ? '<span class="zu-sv3-dcell zu-sv3-dnum" role="cell">' + (rm.tps != null ? spdEsc(spd3FmtV(rm.tps) + SPD_L(" t/s", " t/s")) : "—") + "</span>" : "") +
        '<span class="zu-sv3-dcell zu-sv3-dnum zu-sv3-pct" role="cell">' + spdEsc(spd3PctTxt(rm.share)) + "</span></div>";
    }
    var top6Pct = 0;
    for (var t6 = 0; t6 < Math.min(6, shareSorted.length); t6++) top6Pct += (shareSorted[t6].share || 0) * 100;
    top6Pct = Math.round(top6Pct);
    var more = "";
    if (shareSorted.length > DEF_ROWS) {
      more = '<button type="button" class="zu-sv3-more" data-sv3-more aria-expanded="' + (expanded ? "true" : "false") + '">' +
        spdEsc(expanded ? SPD_L("收起", "Show less")
          : SPD_L("查看全部 " + shareSorted.length + " 个模型", "Show all " + shareSorted.length + " models")) + "</button>";
    }
    var missN = an.selMissing && an.selMissing.length ? an.selMissing.length : 0;
    return '<div class="zu-sv3-left">' + headRow +
      spd3MainNumHTML(overall.v) +
      (bd ? spd3BandHTML(bd) : "") +
      '<div class="zu-sv3-count">' + SPD3_SVG_CUBE + "<span>" +
      spdEsc(SPD_L("本期有效 " + models.length + " 个模型 · " + turns + " 轮",
        models.length + " active models · " + turns + " turns")) + "</span>" +
      (missN ? '<em class="zu-sv3-count-miss">' + spdEsc(SPD_L("已选模型中 " + missN + " 个在当前范围无有效记录",
        missN + " selected models have no valid records in this range")) + "</em>" : "") + "</div>" +
      '<div class="zu-sv3-dist-h">' + spdEsc(SPD_L("所选模型分布 · 按请求数", "Selected models · by requests")) + "</div>" +
      '<div class="zu-sv3-dbar" role="img" aria-label="' +
      spdEsc(SPD_L("模型分布：" + models.length + " 个模型，前 " + Math.min(6, models.length) + " 占 " + top6Pct + "%",
        "Distribution: " + models.length + " models, top " + Math.min(6, models.length) + " at " + top6Pct + "%")) + '">' + bar + "</div>" +
      '<div class="zu-sv3-dwrap"><div class="zu-sv3-dtab' + (msAvail ? "" : " zu-sv3-dtab-noms") +
      '" role="table">' + thead + rowsHtml + "</div></div>" + more + stats + "</div>";
  }
  /* ==================== ④b 图表区空态（v387 §11.4） ====================
   * an.real 空（或 !an.overall）时 spd3CardHTML 用本函数替换 <!--CHART--> 占位——占位
   * 不复存在，wire 的 replace 自然落空、不注入 charts 产物（链路无需改 wire）。
   * 原因行 an.emptyReason 由 core 按池构成供给（有则显），缺席回退通用句；
   * 动作按钮 data-sv3-act（委托接入归 01/06 集成线）：clear-filter=清除模型筛选
   * （仅显式筛选/filt 缺席时以 selMissing 在场判定）、all-time=查看全部时间
   * （period≠all）。 */
  function spd3EmptyStateHTML(an, filt) {
    an = an || {};
    var acts = "";
    if ((filt && filt.mode === "sel") || (an.selMissing && an.selMissing.length))
      acts += '<button type="button" class="zu-sv3-act" data-sv3-act="clear-filter">' +
        spdEsc(SPD_L("清除模型筛选", "Clear model filter")) + "</button>";
    if (an.period !== "all")
      acts += '<button type="button" class="zu-sv3-act" data-sv3-act="all-time">' +
        spdEsc(SPD_L("查看全部时间", "View all time")) + "</button>";
    var reason = an.emptyReason ||
      SPD_L("当前范围和模型筛选下暂无可用数据", "No data available for the current scope and model filter");
    return '<div class="zu-sv3-empty-wrap"><div class="zu-sv3-empty" role="status">' +
      '<div class="zu-sv3-empty-t">' + spdEsc(SPD_L("暂无生成速度数据", "No generation speed data")) + "</div>" +
      '<div class="zu-sv3-empty-r">' + spdEsc(reason) + "</div>" +
      (acts ? '<div class="zu-sv3-empty-acts">' + acts + "</div>" : "") + "</div></div>";
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
      /* 根（§11.1 宽度链）：920 基准定宽、视口余量 60px；max-width:100% 保证窄窗时
       * 根 ≤ tip 内容区、不反向撑大；高度档位由 spd3HeightTier 写入 root 内联
       * min-height（§12.1，CSS 不再定恒定 480 基准），禁止根容器 overflow:hidden */
      ".zu-sv3-root{position:relative;display:flex;flex-direction:column;box-sizing:border-box;" +
        "width:min(920px,calc(100vw - 60px));max-width:100%;" +
        "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
        "color:var(--color-foreground,#e9edf4)}" +
      ".zu-sv3-root,.zu-sv3-root *{box-sizing:border-box}" +
      ".zu-light .zu-sv3-root{color:var(--color-foreground,#1c212b)}" +
      /* ---- 头部：标题居左，范围/时间双 Tab 组整体靠右（V2 .zu-sv-head 视觉契约） ---- */
      ".zu-sv3-root .zu-sv-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin-bottom:10px}" +
      ".zu-sv3-root .zu-sv-title{display:inline-flex;align-items:center;gap:6px;font-weight:700;" +
        "font-size:calc(var(--ui-font-size,14px) + 6px);letter-spacing:.2px;min-width:0}" +
      ".zu-sv3-root .zu-sv-title svg{flex:0 0 auto}" +
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
      /* ---- 筛选条：漏斗+标签入口 | chips | 计数。§12.4 恒单行：fbar/chips 双层
       * nowrap（chips 内部换行会撑出第二行），chips 区 flex:1 1 auto + overflow:hidden
       * 视觉收纳（常驻预算 3 枚 + +N，超出裁切不换行），计数 flex:0 0 auto ---- */
      ".zu-sv3-root .zu-sv3-fbar{display:flex;align-items:center;flex-wrap:nowrap;gap:6px;padding:5px 10px;margin-bottom:10px;" +
        "border:1px solid var(--color-popover-border,rgba(255,255,255,.1));border-radius:9px;background:rgba(255,255,255,.03)}" +
      ".zu-light .zu-sv3-root .zu-sv3-fbar{background:rgba(0,0,0,.03);border-color:rgba(15,23,42,.1)}" +
      ".zu-sv3-root .zu-sv3-fico{display:inline-flex;flex:0 0 auto;opacity:.75;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* §14.1：「模型筛选」标签为真 button（弹出层入口，data-sv3-fopen）——button-reset
       * 后保留原文字样式，hover 反馈 + 焦点环 */
      ".zu-sv3-root .zu-sv3-flabel{appearance:none;border:0;background:transparent;font-family:inherit;" +
        "margin:0;padding:0;font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6);" +
        "flex:0 0 auto;cursor:pointer;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-flabel:hover{color:var(--color-foreground,#e9edf4)}" +
      ".zu-sv3-root .zu-sv3-flabel:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv3-root .zu-sv3-chips{display:flex;flex:1 1 auto;flex-wrap:nowrap;gap:4px;min-width:0;overflow:hidden}" +
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
      /* §14.1：+N 为真 button（弹出层入口，data-sv3-fopen）——button-reset + hover 反馈 */
      ".zu-sv3-root .zu-sv3-chip-more{appearance:none;border:0;background:transparent;font-family:inherit;" +
        "display:inline-flex;align-items:center;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);padding:3px 6px;border-radius:6px;" +
        "flex:0 0 auto;font-variant-numeric:tabular-nums;cursor:pointer}" +
      ".zu-sv3-root .zu-sv3-chip-more:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv3-root .zu-sv3-chip-more:hover{background:rgba(0,0,0,.05)}" +
      ".zu-sv3-root .zu-sv3-chip-more:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      ".zu-sv3-root .zu-sv3-fcount{margin-left:auto;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6);font-variant-numeric:tabular-nums;flex:0 0 auto;white-space:nowrap}" +
      /* ---- 主区：左卡 250px 固定 + 右图表自适应（≤760px 视口左卡收 220px） ---- */
      ".zu-sv3-root .zu-sv3-main{display:flex;gap:12px;align-items:stretch;flex:1;min-height:0}" +
      /* §13.5：padding-bottom 12px（原 10px）——stats 恢复 Footer 贴底后卡底仍保呼吸 */
      ".zu-sv3-root .zu-sv3-left{flex:0 0 250px;min-width:0;display:flex;flex-direction:column;min-height:0;" +
        "border:1px solid var(--color-popover-border,rgba(255,255,255,.14));border-radius:12px;padding:10px 12px 12px}" +
      ".zu-light .zu-sv3-root .zu-sv3-left{border-color:rgba(15,23,42,.14)}" +
      /* §15.2（v391）：边框/圆角/padding 只挂外层卡 [data-sv3-chart]——charts 分片内层
       * 内容盒同名 .zu-sv3-chart 曾双重命中同一规则，绘图区外多一层边框+双层 padding */
      ".zu-sv3-root .zu-sv3-chart{flex:1 1 0;min-width:0;max-width:100%;display:flex;flex-direction:column;min-height:0}" +
      ".zu-sv3-root .zu-sv3-chart[data-sv3-chart]{border:1px solid var(--color-popover-border,rgba(255,255,255,.14));" +
        "border-radius:12px;padding:10px 12px}" +
      ".zu-light .zu-sv3-root .zu-sv3-chart[data-sv3-chart]{border-color:rgba(15,23,42,.14)}" +
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
      ".zu-sv3-root .zu-sv3-count{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;margin-top:8px;min-width:0;" +
        "font-size:calc(var(--ui-font-size,14px) - 1px);font-weight:600}" +
      ".zu-sv3-root .zu-sv3-count svg{flex:0 0 auto;opacity:.85}" +
      /* §11.3：selMissing 非空时计数行下的无有效记录提示（整行小字） */
      ".zu-sv3-root .zu-sv3-count-miss{flex:1 1 100%;font-style:normal;font-weight:400;" +
        "font-size:calc(var(--ui-font-size,14px) - 3px);color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-sv3-kv{display:flex;align-items:baseline;justify-content:space-between;gap:8px;" +
        "font-size:calc(var(--ui-font-size,14px) - 2px);margin-top:6px;min-width:0}" +
      ".zu-sv3-root .zu-sv3-kv i{font-style:normal;color:var(--color-tooltip-tag-foreground,#a6a6a6);flex:0 0 auto}" +
      ".zu-sv3-root .zu-sv3-kv b{font-weight:600;font-variant-numeric:tabular-nums;min-width:0;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;text-align:right}" +
      /* v391 §15.1：「本期统计」组标题（.zu-sv3-cov-h）随字段删除整链退役 */
      /* §13.5 分布条对齐：dist-h/dbar/dwrap 同为左卡内容盒的全宽块级子元素，三者一律
       * 零水平 margin/padding（v388 态核查已达标，此处显式锁口径）——左右缘对齐误差
       * ≤2px；dbar 的 4px 圆角端头是视觉内收（≤4px 感知差）而非几何错位；dwrap 展开
       * 出纵向滚动条时表内容随宿主滚动条形态内缩，同非容器错位。 */
      ".zu-sv3-root .zu-sv3-dist-h{margin-top:10px;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* §14.2 dbar 轨道契约（PRD §5.3）：轨道恒 8px 圆角条，段宽=真实 share、Σ段宽
       * 恒 100%——min-width 下限废除（§14 诊断③：多极小段时 Σ宽>100% 触发 flex 收缩
       * 致比例失真），overflow:hidden 只兜底亚像素取整；cursor:default 表明非交互，
       * 悬停信息走段级 title */
      ".zu-sv3-root .zu-sv3-dbar{display:flex;align-items:stretch;height:8px;border-radius:4px;overflow:hidden;margin-top:6px;" +
        "background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv3-root .zu-sv3-dbar{background:rgba(0,0,0,.06)}" +
      ".zu-sv3-root .zu-sv3-dbar i{display:block;height:100%;align-self:stretch;flex-shrink:0;min-width:0;" +
        "margin:0;padding:0;border:0;border-radius:0;cursor:default}" +
      /* §11.3：分布表容器 150px 内滚——展开全部行也不撑高左卡；§12.2 表体 div Grid：
       * 每行同款三列模板 minmax(0,1fr) 64px 44px（名称列可收缩至 0 + ellipsis → 行恒
       * 不溢出，根除旧 table 23px 横向溢出；行/容器不写 overflow-x，由 grid 保证）；
       * 数字列右对齐 tabular-nums；行高紧凑 24px；msAvail=false 两列变体（去均速列） */
      ".zu-sv3-root .zu-sv3-dwrap{max-height:150px;overflow-y:auto;margin-top:6px;min-height:0}" +
      ".zu-sv3-root .zu-sv3-dtab{font-size:calc(var(--ui-font-size,14px) - 3px);font-variant-numeric:tabular-nums}" +
      ".zu-sv3-root .zu-sv3-drow{display:grid;grid-template-columns:minmax(0,1fr) 64px 44px;" +
        "align-items:center;min-height:24px}" +
      ".zu-sv3-root .zu-sv3-dtab.zu-sv3-dtab-noms .zu-sv3-drow{grid-template-columns:minmax(0,1fr) 44px}" +
      ".zu-sv3-root .zu-sv3-dhead{font-weight:400;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-sv3-dcell{min-width:0;overflow:hidden;text-align:left}" +
      ".zu-sv3-root .zu-sv3-dnum{text-align:right;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-dname{display:flex;align-items:center;gap:6px}" +
      ".zu-sv3-root .zu-sv3-dname .zu-sv3-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      /* §15.4（v391）：「查看全部 N 个模型」模型列表下方水平居中、轻量次级文本按钮 */
      ".zu-sv3-root .zu-sv3-more{appearance:none;border:0;background:transparent;font-family:inherit;" +
        "display:block;width:100%;text-align:center;color:var(--color-tooltip-tag-foreground,#a6a6a6);" +
        "font-size:calc(var(--ui-font-size,14px) - 3px);padding:5px 8px;margin:2px 0 0;border-radius:7px;cursor:pointer}" +
      ".zu-sv3-root .zu-sv3-more:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.05)}" +
      ".zu-light .zu-sv3-root .zu-sv3-more:hover{background:rgba(0,0,0,.04)}" +
      ".zu-sv3-root .zu-sv3-more:active{opacity:.7}" +
      ".zu-sv3-root .zu-sv3-more:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      /* §13.5 stats 恢复 Footer 语义（推翻 v388 §12.2 的「禁 auto」：第三轮断层实为
       * 分布表缺失时的推底空腔，§12.2 分布表 Grid 化后左卡内容密度已足够）——内容少
       * 时 margin-top:auto 贴底成 Footer，多模型分布表长时 auto=0 自然紧贴上一节；
       * 分隔线（border-top）与 padding-top 固定间距保留 */
      ".zu-sv3-root .zu-sv3-stats{display:flex;gap:10px;margin-top:auto;padding-top:10px;" +
        "border-top:1px solid var(--color-popover-border,rgba(255,255,255,.1))}" +
      ".zu-light .zu-sv3-root .zu-sv3-stats{border-color:rgba(15,23,42,.1)}" +
      ".zu-sv3-root .zu-sv3-stat{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px}" +
      ".zu-sv3-root .zu-sv3-stat i{font-style:normal;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-sv3-stat b{font-weight:600;font-variant-numeric:tabular-nums;" +
        "font-size:calc(var(--ui-font-size,14px) + 2px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".zu-sv3-root .zu-sv3-notice{margin-top:8px;font-size:calc(var(--ui-font-size,14px) - 3px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* ---- §11.4 图表区空态：占满图表卡余高居中，标题+原因行+动作按钮 ---- */
      ".zu-sv3-root .zu-sv3-empty-wrap{flex:1 1 auto;min-height:160px;display:flex;align-items:center;justify-content:center}" +
      ".zu-sv3-root .zu-sv3-empty{text-align:center;max-width:420px;padding:12px}" +
      ".zu-sv3-root .zu-sv3-empty-t{font-weight:600;font-size:calc(var(--ui-font-size,14px) + 2px)}" +
      ".zu-sv3-root .zu-sv3-empty-r{margin-top:6px;font-size:calc(var(--ui-font-size,14px) - 2px);" +
        "color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zu-sv3-root .zu-sv3-empty-acts{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px}" +
      ".zu-sv3-root .zu-sv3-act{appearance:none;border:1px solid var(--color-popover-border,rgba(255,255,255,.16));" +
        "background:transparent;color:var(--color-brand,#a3cfff);font-family:inherit;" +
        "font-size:calc(var(--ui-font-size,14px) - 2px);padding:4px 12px;border-radius:999px;cursor:pointer;white-space:nowrap}" +
      ".zu-sv3-root .zu-sv3-act:hover{color:var(--color-foreground,#e9edf4);background:rgba(255,255,255,.06)}" +
      ".zu-light .zu-sv3-root .zu-sv3-act:hover{background:rgba(0,0,0,.05)}" +
      ".zu-sv3-root .zu-sv3-act:focus-visible{outline:2px solid var(--color-brand,#a3cfff);outline-offset:1px}" +
      /* ---- 筛选弹出层（§14.1）：锚定筛选栏正下方——默认 top:87px（头部 ~45 + fbar
       * 单行 ~34 + 8px 间距）；实际 top 由打开入口按 fbar 实测底缘写入 pop.top
       * （spd3CardHTML 内联覆写，字号缩放安全）；右缘对齐 right:10px、宽 340px；
       * 卡高 ≥320 恒容纳，无翻转逻辑；bottom:10px 废除 ---- */
      ".zu-sv3-root .zu-sv3-fpop{position:absolute;right:10px;top:87px;z-index:6;width:340px;max-width:calc(100% - 20px);" +
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
      /* v387 §11.1 宽度链（P0-01 唯一权威方案）：V3 卡 920 基准必须压过 .tip 基类 560 帽与
       * tpsTip 内联 520 帽。真机实测两链 tip 均为 border-box（.tip padding 10/13、compact
       * padding 10/14 + border 1px）→ 内容区 = 宽 − padding − border；释放规则改 952 帽 +
       * border-box 后两链内容区 ≥922 ≥ 根 920，根不再越出 tip 外缘。max-width 用纯视口帽
       * （952 帽只在 width 生效）；根侧 max-width:100% 保证窄窗不反向撑大。禁止给根加
       * overflow:hidden 掩盖；验收=tip.scrollWidth==clientWidth 且筛选行右缘 ≤ 内容右缘 */
      ".tip:has(.zu-sv3-root),.zusage-tps-tip:has(.zu-sv3-root){box-sizing:border-box!important;" +
        "width:min(952px,calc(100vw - 24px))!important;max-width:calc(100vw - 24px)!important}" +
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
  /* ==================== ⑧b 高度档位（§12.1）：root min-height 离散档 ====================
   * min-height:480px 废除——恒定高与内容脱节（真机 rootH 543 视图间不变）。改纯函数
   * 按 an 算离散档位（px 实现值，spec §12.1 允许 ±10 盒模型校准）：empty→320 /
   * recent n≤3→340、n≤8→360、n≤18→390 / today→400 / week→400 / month rows≤4→430、
   * 5→450、6→470 / all 日桶≤56→380、≤112→420、else→460。离散保证稳定：hover/快照
   * 刷新不改变 tier；时间 Tab 切换允许跳档；模型展开不撑高（分布表内滚上限不变）。
   * 返回 {tier, px}：tier 进 root data-h-tier（测试/harness 定位），px 进内联
   * min-height。root 高度语义=min-height（内容可超出）；左卡与图表卡等高由
   * .zu-sv3-main 的 flex stretch 承担；左卡自然内容流、stats 段 margin-top:auto
   * Footer 化（§13.5，推翻 §12.2 的「禁 auto」）。 */
  function spd3HeightTier(an) {
    an = an || {};
    /* v393（spec §17，用户裁定 2026-11-19）：五形态统一 450——最近/今天/近7天/本月/全部
     * 任意切换高度恒定（真机五截图对账：旧表 320..470 五档在范围间跳变）；empty（无数据
     * 空态）同高。450 取旧 month-r5 档：6 行月历经 v391 行高帽自适应（84px 帽、行数多时
     * 行内分配）在 450 内可读；柱/折线视图 plot 弹性吃满（max-height 上限同批废除）。
     * tier 名保留 period/empty 语义（data-h-tier 仅诊断用）；min-height 语义不变（内容
     * 可超出——多模型分布表展开等仍自然撑高）。 */
    var p = (an && an.period) || "";
    if (!(an.real && an.real.length) || !an.overall) return { tier: "empty", px: 450 };
    if (p === "recent") return { tier: "recent", px: 450 };
    if (p === "today") return { tier: "today", px: 450 };
    if (p === "week") return { tier: "week", px: 450 };
    if (p === "month") return { tier: "month", px: 450 };
    return { tier: "all", px: 450 };
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
    /* v390 §14.1：打开入口按 fbar 实测底缘写入 pop.top（06/01 委托），内联覆写
     * CSS 默认 87px——字号缩放/紧凑链下 fbar 高度变化安全 */
    if (pop && ctx.pop && spdNum(ctx.pop.top) > 0)
      pop = pop.replace('class="zu-sv3-fpop"', 'class="zu-sv3-fpop" style="top:' + spdNum(ctx.pop.top) + 'px"');
    /* 真单模型池（§11.5）：chips 池恰 1 个且非 missing——「唯一模型」徽标只在场 */
    var poolSingle = pool.length === 1 && !pool[0].missing;
    /* §11.4：real 空 / overall 缺 → 图表占位换居中空态（占位不在，wire replace 落空
     * 自然不注入 charts 产物）；有数据恒保留占位原样。触发判据=an.real（spec §11.4
     * 字面）而非 perModel——降级帧（旧二元组）+筛选时 core 保留整行 out/ms（models
     * 置空），此时有真实数据与柱，绝不能误报「无数据」+伪造 0 轮（审查 MAJOR-1）。 */
    var empty = !(an.real && an.real.length) || !an.overall;
    var chartSlot = empty ? spd3EmptyStateHTML(an, filt) : "<!--CHART-->";
    /* §12.1：高度档位内联 min-height + data-h-tier（class/data-sv-key 相邻契约保持） */
    var ht = spd3HeightTier(an);
    return '<div class="zu-sv3-root" data-sv-key="' + key + '" data-h-tier="' + ht.tier +
      '" style="min-height:' + ht.px + 'px">' + spd3StylesHTML() +
      spd3HeadHTML(an) +
      spd3FilterBarHTML(pool, filt, { selMissing: an.selMissing, pop: ctx.pop,
        active: an.perModel ? an.perModel.length : 0 }) +
      '<div class="zu-sv3-main">' + spd3LeftHTML(an, ctx.live, !!ctx.expanded, poolSingle,
        ctx.o && ctx.o.fmtTok) +
      '<div class="zu-speed-chart zu-sv3-chart" data-sv3-chart>' + chartSlot + "</div></div>" +
      (notice ? '<div class="zu-sv3-notice">' + spdEsc(notice) + "</div>" : "") +
      pop + "</div>";
  }
  /* SPD_V3_VIEW_END */
