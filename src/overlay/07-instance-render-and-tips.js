    /* ---------- 渲染 ---------- */
    function fmt(n, count) {
      n = n || 0;
      if (state.forceKmb && !count) {
        // 按原始 token 数四舍五入，避免缩放后的浮点半数偏差。
        if (n >= 1e9) return (Math.round(n / 1e7) / 100).toFixed(2) + "B";
        if (n >= 1e6) return (Math.round(n / 1e4) / 100).toFixed(2) + "M";
        if (n >= 1e3) return (Math.round(n / 100) / 10).toFixed(1) + "K";
        return String(n);
      }
      if (cnUnits()) {
        if (n >= 1e8) return cnUnit(n / 1e8) + "亿";
        if (n >= 1e4) return cnUnit(n / 1e4) + "万";
        return String(n);
      }
      if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(n);
    }
    function countFmt(n) { return fmt(n, true); }
    function cnUnit(x) { return x.toFixed(2).replace(/\.?0+$/, ""); }   // 至多两位小数并去尾零：58.25万、142万、1亿（数字与单位不留空格：等宽字体下空格占满一格）
    function sec(ms) { return ms ? (ms / 1000).toFixed(1) + "s" : "–"; }
    /* v300：长时长换算（会话累计「会话总耗时」专用）——跨会话总生成时长可达小时级，
     * 裸秒数（12301.2s）既难读又会撑爆 1/3 列宽；<1min 显秒、<1h 显分钟、其余显小时 */
    function secLong(ms) {
      if (!ms) return "–";
      var s2 = ms / 1000;
      if (s2 < 60) return s2.toFixed(1) + "s";
      if (s2 < 3600) return (s2 / 60).toFixed(1) + "m";
      return (s2 / 3600).toFixed(1) + "h";
    }


    /* 超限判定：最近一次"上下文超限被拒"晚于最近成功请求 = 仍处于超限状态（该请求
     * status=error，不进任何 completed 统计，只能这样单独检测）。html() 与气泡共用。 */
    function excActive(s) {
      return !!(s && s.ctx_exc > 0 && s.ctx_exc >= (s.last_at || 0));
    }

    function cachePct(cache, input) {
      // 无原生 title：原生提示向下弹且与自绘 tooltip 双显闪烁（v33 移除），定义见各项 tooltip 明细
      return input > 0 ? '<span class="dim">' + Math.round(cache / input * 100) + "%</span>" : "";
    }

    /* 档位表（v131 用户规格 2026-10-27）：额度/上下文各五档，按已用百分比判定（含下限不含
     * 上限），从高到低首个命中即档；类名与下方 CSS 手写规则同源（TPS_BANDS 同款纪律）。
     * 额度五档=emerald/sky/amber/orange/rose，上下文五档=slate/indigo/violet/orange/red；
     * 额度 ≥100% 满档（zu-qb-exc）保留 v127 呼吸闪烁特效（用户规格）。 */
    var CTX_BANDS = [
      { min: 90, cls: "crit" },
      { min: 80, cls: "high" },
      { min: 50, cls: "mid" },
      { min: 30, cls: "norm" },
      { min: 0, cls: "calm" },
    ];
    var QUOTA_BANDS = [
      { min: 100, cls: "zu-qb-exc" },
      { min: 90, cls: "zu-qb-crit" },
      { min: 80, cls: "zu-qb-high" },
      { min: 50, cls: "zu-qb-mid" },
      { min: 30, cls: "zu-qb-norm" },
      { min: 0, cls: "zu-qb-calm" },
    ];
    function bandOf(bands, pct) {
      for (var i = 0; i < bands.length; i++) if (pct >= bands[i].min) return bands[i].cls;
      return bands[bands.length - 1].cls;
    }
    /* 上下文分档口径（v93 起唯一消费方是原生按钮增强；原状态条上下文格已删）。
     * cw 优先级：手动覆盖 > 原生按钮 aria-label 读到的总量（nativeCtxVal）> 会话 context_window。
     * 压缩激活（exc）是过程态优先档；v92 百万窗口提前预警（40/60）随统一百分比规格废止。 */
    function ctxBandOf(sess) {
      var cw = parseInt(state.ctxOv, 10) || nativeCtxVal || (sess && sess.context_window) || 0;
      var pct = cw ? (sess && sess.ctx || 0) / cw * 100 : 0;
      var exc = excActive(sess);
      return { cw: cw, pct: pct, cls: exc ? "exc" : bandOf(CTX_BANDS, pct), exc: exc };
    }

    /* 显示顺序：本轮 → 会话 → 工具 → 今日 → 子代理；token 后带缓存命中率。
     * v31：条面只放主数值；悬停改自绘 tooltip（向上弹），随渲染以 tips[]
     * 按 .it 顺序挂到元素 __tip，全部为字符串单页（{tabs:[...]} 多 tab 机制 v49 起
     * 无条目使用已删除：子代理改点击面板，tooltip 不再承载 tab 切换）。
     * 缓存写入/思考/重试/错误均 >0 才显示，0 时不产生噪音。 */
    function fmtTime(ms) {
      var d = ms ? new Date(ms) : null;
      return d ? (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" +
        (d.getMinutes() < 10 ? "0" : "") + d.getMinutes() + ":" +
        (d.getSeconds() < 10 ? "0" : "") + d.getSeconds() : "?";
    }
    function fmtStart(ms) {   // 「最后活动」等非时间范围时间戳：完整日期 YYYY-MM-DD HH:MM（v210 起时间范围行全部改用 fmtStartS）
      if (!ms) return "?";
      var d = new Date(ms);
      function two(v) { return (v < 10 ? "0" : "") + v; }
      return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
        " " + two(d.getHours()) + ":" + two(d.getMinutes());
    }
    function fmtStartS(ms) {   // 时间范围行精确到秒：v166 会话累计/项目累计先行，v210 用户规格扩展到本轮/今日合计与速率 tooltip 最近一段（全部时间范围行统一到秒）
      if (!ms) return "?";
      var d = new Date(ms);
      function two(v) { return (v < 10 ? "0" : "") + v; }
      return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
        " " + two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
    }
    /* v222：速度卡「时间范围」行取值——主数字为会话均/桥态时取会话累计口径
     * （started→last_at，与会话累计 tooltip 同源同款）；「最近一段」回退态取段范围
     * （startedAt→endedAt）。起点缺失视为无有效范围（半程范围无意义），整行不渲染。 */
    function speedSpan(started, ended) {
      return started ? { start: fmtStartS(started), end: ended ? fmtStartS(ended) : "" } : null;
    }
    function ioc(inp, out, cache, rea, cw) {   // 悬停明细行：输入/输出/缓存命中/缓存写入/思考
      return L("输入 ", "Input ") + fmt(inp) + L(" / 输出 ", " / Output ") + fmt(out) + L(" / 缓存命中 ", " / Cache read ") + fmt(cache) +
        (cw > 0 ? L(" / 缓存写入 ", " / Cache write ") + fmt(cw) : "") +
        (rea > 0 ? L(" / 思考 ", " / Thinking ") + fmt(rea) : "");
    }
    /* 结构化 tooltip（v67.1）：\x01 前缀标记 HTML 内容（drawTip 分流），行/脚注排版与
     * 回复末尾统计行 tooltip 同款；动态值一律过 ttEsc（innerHTML 安全，如工具名/错误文案） */
    function ttEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function ttH(t) { return '<div class="rt-h">' + ttEsc(t) + "</div>"; }
    var RT_ATOM_RE = /(?:[¥$]\d[\d,.]*|\b\d[\d,.]*(?:\s*(?:tok\/s|t\/s|tokens?|requests?|calls?|s|ms|次|轮|万|亿|%))(?=$|[\s，；。·（）()]))/g;
    function ttAtomHtml(escaped) { return escaped.replace(RT_ATOM_RE, '<span class="rt-atom">$&</span>'); }
    function ttRow(k, v) {
      return '<div class="rt-row"><b>' + ttEsc(k) + '</b><span>' + ttAtomHtml(ttEsc(v)) + "</span></div>";
    }
    /* v164：吸底行（时间范围）——长明细滚动时固定在滚动视口底缘，内容不足时无异状 */
    function ttRowPin(k, v) {
      return '<div class="rt-row rt-pin"><b>' + ttEsc(k) + '</b><span>' + ttAtomHtml(ttEsc(v)) + "</span></div>";
    }
    function ttNote(v) { return '<div class="rt-note">' + ttEsc(v) + "</div>"; }
    /* ---------- v202 预估费用（USD 快照原值 × 快照 fx 汇率）----------
     * 汇率由 zusage.py 侧 12h 同步（models.dev 牌价 + er-api 汇率），快照只带 USD 原值
     * 与 fx 视图；这里才取整到分。无有效汇率诚实降级 $ 原值，不编造汇率。 */
    function fxRate() {
      var fx = state.data && state.data.fx;
      return (fx && typeof fx.rate === "number" && isFinite(fx.rate) && fx.rate > 0) ? fx.rate : 0;
    }
    function fmtMoney(usd) {
      var rate = fxRate();
      if (rate > 0) {
        var v = usd * rate;
        return (v > 0 && v < 0.01) ? "<¥0.01" : "¥" + v.toFixed(2);
      }
      return (usd > 0 && usd < 0.01) ? "<$0.01" : "$" + usd.toFixed(2);
    }
    /* 费用行：开关关/字段缺失（旧快照、远端旧版）都不渲染，不显假 0。
     * 手拼不走 ttRow——值区要嵌问号 icon（ttEsc 会转义标签）；v202.1 icon 悬停
     * 弹预估费用说明小气泡（fxTip，监听挂 tip 本体 mouseover/out 委托）。 */
    function costTipRow(x) {
      if (!(state.cost && typeof x === "number" && isFinite(x))) return "";
      /* icon 并入同一 rt-atom（inline-block+nowrap）：atom 后跟独立 svg 会被断行
       * 到下一行（实测），整块 nowrap 保「¥X.XX ?」恒同行 */
      return '<div class="rt-row"><b>' + ttEsc(L("预估费用", "Est. cost")) + '</b><span>' +
        '<span class="rt-atom">' + ttEsc(fmtMoney(x)) + FXQ_ICON + "</span></span></div>";
    }
    /* 紧简摘要行的费用尾注（tpsChipTipHTML 四格摘要共用） */
    function costSuffix(x) {
      return (state.cost && typeof x === "number" && isFinite(x)) ? L(" · ", " · ") + fmtMoney(x) : "";
    }
    /* ---------- v214 项目累计统计卡（buildProjectTipHTML）----------
     * 层级：标题与范围 → 三项核心指标 → 用量明细 → 运行规模 → 模型明细表 → 时间范围。
     * 费用完整复用既有链路（pj.cost_usd / m1.cost_usd / fmtMoney，0 是有效金额，缺失显 "—"）。
     * 展开态保存在实例（projTipKey/projTipExpanded），归属键=sid+":"+起始时刻，项目变化自动重置；
     * 展开/收起走局部更新（projTipApplyModels）不重建整卡；数据刷新仍走 tipSig 全量签名。 */
    var projTipKey = "", projTipExpanded = false, projTipList = null;
    function escAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function pjRowsHTML(list, full) {
      var showCost = !!state.cost;   // ⚙ 开关关：费用列整体不渲染（与费用行同语义）
      return list.map(function (m1) {
        var name = m1.model || L("未知模型", "unknown");
        return '<tr>' +
          '<td class="zu-pj-mname"' + (full ? ' title="' + escAttr(name) + '"' : '') + '>' + ttEsc(name) + '</td>' +
          '<td>' + ttEsc(fmt(m1.total || 0)) + '</td>' +
          '<td>' + ttEsc(countFmt(m1.requests || 0)) + '</td>' +
          (showCost ? '<td>' + (typeof m1.cost_usd === "number" && isFinite(m1.cost_usd) ? ttEsc(fmtMoney(m1.cost_usd)) : "—") + '</td>' : "") +
          '</tr>';
      }).join("");
    }
    function pjRowsFor(pj, expanded) {
      /* 上游 _project_usage 已按 total 降序；此处对副本再排序（稳定），不改快照原数组 */
      var list = (pj.models || []).slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); });
      return expanded ? list : list.slice(0, 6);
    }
    function buildProjectTipHTML(pj, ownerKey) {
      projTipKey = ownerKey;
      var expanded = projTipExpanded;
      var fullList = (pj.models || []).slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); });
      projTipList = fullList;
      var shown = expanded ? fullList : fullList.slice(0, 6);
      var hasModels = fullList.length > 0;
      var hitPct = (pj.input > 0 && isFinite(pj.input)) ? Math.round((pj.cache_read || 0) / pj.input * 100) : -1;
      var showCost = !!state.cost;   // ⚙ 开关关：KPI 预估费用格与表头费用列不渲染
      var costV = (typeof pj.cost_usd === "number" && isFinite(pj.cost_usd)) ? fmtMoney(pj.cost_usd) : "—";
      /* v303 根类并入统计卡家族：statCompactStyle("project") :has 作用域（450 宽/
       * 自适应高/共享规则）在此生效；zu-project-tip 保留（fxq 计价范围气泡与测试锚点） */
      return statCompactStyle("project") +
        '<div class="zu-project-tip zu-stat-tip zu-stat-tip--project" data-key="' + escAttr(ownerKey) + '">' +
        '<div class="zu-pj-head"><div class="zu-pj-title' + (pj.name ? " zu-tt-name" : "") + '">' + ttEsc(L("项目累计", "Project total")) +
        (pj.name ? '<span class="zu-pj-pname" title="' + escAttr(pj.name) + '">' + ttEsc(pj.name) + '</span>' : "") + '</div>' +
        '<div class="zu-pj-range"><span class="zu-pj-scope">' + ttEsc(L("全部请求 · 含子代理", "All requests · incl. sub-agents")) + '</span></div></div>' +
        /* v303 项目累计紧凑化（用户 /goal，同本轮/会话/今日四行 KPI 形态）：
         * ①总用量|输入(缓存 N% 徽标随标签)|输出(含思考) ②请求次数|请求轮数|请求会话
         * ③平均耗时|平均延迟|总耗时 ④平均输出速度(项目加权均 avg_tps 档色)|预估费用；
         * 平均耗时/延迟/总耗时/平均输出速度为 v303 zusage _project_usage 新聚合
         * （>0 门控，旧缓存自然降级）；缓存命中率不再占独立副行。 */
        '<div class="zu-turn-kpis">' +
          statKpi(kpiIco("total") + L("总用量", "Total tokens"), ttEsc(fmt(pj.total || 0)), turnVBkt(fmt(pj.total || 0))) +
          statKpi(kpiIco("input") + L("输入", "Input") +
            (hitPct >= 0 ? '<span class="hit zu-turn-hit">' + ttEsc(L("缓存", "cache ") + hitPct + "%") + '</span>' : ""),
            ttEsc(fmt(pj.input || 0)), turnVBkt(fmt(pj.input || 0))) +
          statKpi(kpiIco("output") + L("输出", "Output"), ttEsc(fmt(pj.output || 0)), turnVBkt(fmt(pj.output || 0)),
            (pj.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(pj.reasoning)) : "")) +
        '</div>' +
        /* 行二：请求规模（请求数/轮数/会话数均为项目聚合真值） */
        '<div class="zu-turn-kpis">' +
          statKpi(kpiIco("requests") + L("请求次数", "Requests"), ttEsc(countFmt(pj.requests || 0)), turnVBkt(countFmt(pj.requests || 0))) +
          statKpi(kpiIco("turns") + L("请求轮数", "Turns"), ttEsc(countFmt(pj.turns || 0)), turnVBkt(countFmt(pj.turns || 0))) +
          statKpi(kpiIco("sessions") + L("请求会话", "Sessions"), ttEsc(countFmt(pj.sessions || 0)), turnVBkt(countFmt(pj.sessions || 0))) +
        '</div>' +
        /* 行三：平均耗时 | 平均延迟 | 总耗时（v303 聚合，>0 门控缺失不伪造 0s） */
        ((pj.avg_duration_ms > 0 || pj.avg_ttft_ms > 0 || pj.duration_ms > 0)
          ? '<div class="zu-turn-kpis zu-turn-kpis--mid">' +
            (pj.avg_duration_ms > 0 ? statKpi(kpiIco("duration") + L("平均耗时", "Avg time"), ttEsc(sec(pj.avg_duration_ms)), turnVBkt(sec(pj.avg_duration_ms))) : "") +
            (pj.avg_ttft_ms > 0 ? statKpi(kpiIco("latency") + L("平均延迟", "Avg TTFT"), ttEsc(sec(pj.avg_ttft_ms)), turnVBkt(sec(pj.avg_ttft_ms))) : "") +
            (pj.duration_ms > 0 ? statKpi(kpiIco("elapsed") + L("总耗时", "Total time"), ttEsc(secLong(pj.duration_ms)), turnVBkt(secLong(pj.duration_ms))) : "") +
            '</div>' : "") +
        /* 行四：平均输出速度（项目加权均，TPS_BANDS 档色）| 预估费用（问号走项目卡既有
         * 计价范围气泡机制）；费用关/缺失时速度格 only-child 占满整行 */
        '<div class="zu-turn-kpis zu-turn-kpis--duo">' +
          ((typeof pj.avg_tps === "number" && isFinite(pj.avg_tps) && pj.avg_tps > 0)
            ? statKpi(kpiIco("speed") + L("平均输出速度", "Avg output rate"), '<b class="' + tpsBand(pj.avg_tps).cls + '">' + ttEsc(pj.avg_tps.toFixed(1)) + '</b> <small>t/s</small>')
            : statKpi(kpiIco("speed") + L("平均输出速度", "Avg output rate"), "—")) +
          ((showCost && typeof pj.cost_usd === "number" && isFinite(pj.cost_usd))
            ? statKpi(L("预估费用", "Est. cost") + FXQ_ICON, ttEsc(costV))
            : "") +
        '</div>' +
        (hasModels
          ? '<div class="zu-pj-models"><div class="zu-pj-mhead"><div class="zu-pj-mtitle">' + ttEsc(L("模型明细", "Models")) + '</div>' +
            '<div class="zu-pj-morder">' +
            ((pj.tool_calls || pj.retries)
              ? [(pj.tool_calls ? ttEsc(L("工具调用 ", "tools ") + countFmt(pj.tool_calls) + L(" 次", " calls")) : ""),
                 (pj.retries ? ttEsc(L("重试 ", "retries ") + countFmt(pj.retries) + L(" 次", " times")) : "")].filter(Boolean).join('<i class="zu-turn-sep">·</i>')
              : ttEsc(L("按用量排序", "by usage"))) + '</div></div>' +
            '<table class="zu-pj-table"><thead><tr><th>' + ttEsc(L("模型", "Model")) + '</th>' +
            '<th>' + ttEsc(L("Token 用量 ↓", "Tokens ↓")) + '</th><th>' + ttEsc(L("请求次数", "Requests")) + '</th>' +
            (showCost ? '<th>' + ttEsc(L("预估费用", "Est. cost")) + '</th>' : "") + '</tr></thead>' +
            '<tbody data-zu-pj-rows>' + pjRowsHTML(shown, true) + '</tbody></table>' +
            (fullList.length > 6
              ? '<button type="button" class="zu-pj-more" data-key="' + escAttr(ownerKey) + '" aria-expanded="' + (expanded ? "true" : "false") + '" aria-controls="zu-pj-rows">' +
                (expanded ? ttEsc(L("收起", "Show less")) : ttEsc(L("查看全部 " + fullList.length + " 个模型", "Show all " + fullList.length + " models")) + ' ▾') + '</button>'
              : "") +
            '</div>'
          : "") +
        '<div class="zu-stat-time"><b>' + ttEsc(L("时间范围", "Time span")) + '</b>' +
        '<span>' + (pj.started ? fmtStartS(pj.started) : "—") + " — " + (pj.last_at ? fmtStartS(pj.last_at) : "—") + '</span></div>' +
        '</div>';
    }
    /* 展开/收起的局部更新：只替换模型行与按钮态，不重建整卡（滚动/焦点/选择不受扰）。
     * 内容串纳入 expanded 态，数据刷新整卡重建时保持展开；归属键不匹配则忽略。 */
    function projTipApplyModels(btn) {
      var root = btn.closest && btn.closest(".zu-project-tip");
      if (!root || btn.getAttribute("data-key") !== projTipKey) return;
      var shown = projTipExpanded ? projTipList : projTipList.slice(0, 6);
      var rows = root.querySelector("[data-zu-pj-rows]");
      if (rows) rows.innerHTML = pjRowsHTML(shown, true);
      btn.setAttribute("aria-expanded", projTipExpanded ? "true" : "false");
      btn.innerHTML = projTipExpanded
        ? ttEsc(L("收起", "Show less"))
        : ttEsc(L("查看全部 " + projTipList.length + " 个模型", "Show all " + projTipList.length + " models")) + " ▾";
      if (typeof positionTip === "function" && tipFor) positionTip(tipFor, true);
    }
    /* v215 统计卡公共片段（六卡共用）：head/KPI/明细/规模/表格/时间。数据全部真实字段。 */
    function statHead(title, scope, name, icoHtml) {
      /* v230.1 名称与标题垂直居中：带名称时标题容器切 flex，名称作为子项中心对齐；
       * v304 第 4 参 icoHtml=标题前置图标（工具卡扳手），既有三参调用不变 */
      return '<div class="zu-stat-head"><div class="zu-stat-title' + (name ? " zu-tt-name" : "") + '">' + (icoHtml || "") + ttEsc(title) +
        (name || "") + '</div>' +
        (scope ? '<div class="zu-stat-scope">' + ttEsc(scope) + '</div>' : "") + '</div>';
    }
    /* v300：本轮/会话累计共用紧凑布局作用域 CSS——同一份规则按卡变体替换 :has 作用域类；
     * 渲染串内联（速度卡同款先例），随内容存在、签名幂等重建不叠加 */
    function statCompactStyle(variant) {
      return '<style>' +

          '.zusage-tip-root:has(.zu-stat-tip--' + variant + '){width:min(450px,calc(100vw - 16px))!important;max-width:min(450px,calc(100vw - 16px))!important;max-height:calc(100vh - 24px)!important;box-sizing:border-box!important;overflow:hidden!important}' +
          /* v303.1 五卡 padding 统一：内容边距只吃根 .tip 的 10px 13px（与速度卡一致），
           * .tbody 不再叠第二层（此前 9px 12px 叠加成 19/25 双层，与速度卡不一致） */
          '.zusage-tip-root:has(.zu-stat-tip--' + variant + ') .tbody{box-sizing:border-box!important;overflow-y:auto!important;scrollbar-gutter:auto!important;scrollbar-width:none!important;padding:0!important}' +
      '.zusage-tip-root:has(.zu-stat-tip--' + variant + ') .tbody::-webkit-scrollbar{display:none!important}' +
          '' + '.zu-stat-tip--' + variant + '{box-sizing:border-box!important;display:flex!important;flex-direction:column!important;gap:3px!important;min-height:0!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-head{margin:0!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-title{font-size:calc(var(--ui-font-size,14px) + 3px)!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-scope{font-size:calc(var(--ui-font-size,14px) - 3px)!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-kpis{display:grid!important;grid-template-columns:repeat(3,1fr)!important;background:rgba(255,255,255,.06)!important;border-radius:8px!important;padding:4px 10px!important;box-sizing:border-box!important}' +
          /* 浅色主题：深色叠加（--color-popover 在宿主恰好等于 tip 本底，不能用变量） */
          '.zusage-tip-root.zu-light:has(.zu-stat-tip--' + variant + ') .zu-turn-kpis,.zusage-tip-root:has(.zu-stat-tip--' + variant + '.zu-light) .zu-turn-kpis{background:rgba(0,0,0,.045)!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-kpis .zu-stat-kpi + .zu-stat-kpi{border-left:1px solid var(--color-popover-border,rgba(255,255,255,.12))!important;padding-left:10px!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-kpi .zu-stat-k{display:flex!important;align-items:baseline!important;gap:6px!important;font-size:calc(var(--ui-font-size,14px) - 3px)!important;font-weight:400!important;color:var(--color-tooltip-tag-foreground,#a6a6a6)!important;margin-bottom:2px!important}' +
      '' + '.zu-stat-tip--' + variant + ' .zu-stat-k .hit{font-size:calc(var(--ui-font-size,14px) - 3px)!important;font-weight:600!important;color:#4ade80!important;white-space:nowrap!important}' +
      '' + '.zu-stat-tip--' + variant + ' .zu-stat-k .tip-fxq{align-self:center!important;vertical-align:initial!important;margin-left:4px!important}' +
      
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-kpi .zu-stat-v{font-size:calc(var(--ui-font-size,14px) + 6px)!important;line-height:1.08!important;font-variant-numeric:tabular-nums!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-kpis--mid .zu-stat-v{font-size:calc(var(--ui-font-size,14px) + 5px)!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-v.zu-turn-l1{font-size:calc(var(--ui-font-size,14px) + 3px)!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-v.zu-turn-l2{font-size:calc(var(--ui-font-size,14px) + 1px)!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-kpis--duo{grid-template-columns:repeat(2,1fr)!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-kpis--duo .zu-stat-kpi:only-child{grid-column:1/-1!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-dsub{font-size:calc(var(--ui-font-size,14px) - 4px)!important;margin-top:1px!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-pj-mhead{margin:0!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-pj-mtitle{font-size:calc(var(--ui-font-size,14px) + 1px)!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-pj-morder{display:block!important;font-size:calc(var(--ui-font-size,14px) - 3px)!important;color:var(--color-tooltip-tag-foreground,#a6a6a6)!important}' +
          '.zu-turn-sep{font-style:normal!important;opacity:.6!important;margin:0 3px!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-models .zu-stat-table{margin:0!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-models th{padding:1px 3px!important;white-space:nowrap!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-models td{padding:2px 3px!important;white-space:nowrap!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-models{flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;scrollbar-width:none!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-turn-models::-webkit-scrollbar{display:none!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-time{margin-top:auto!important;padding-top:5px!important;border-top:1px solid var(--color-popover-border,rgba(255,255,255,.12))!important;font-size:calc(var(--ui-font-size,14px) - 4px)!important}' +
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-time span{font-variant-numeric:tabular-nums!important}' +
          /* v301.1 图标规则三卡共享：flex baseline 标签行内图标 align-self:center
           * （SVG 基线=底缘，随 baseline 会沉到行下缘），文字/徽标基线关系不变 */
          '' + '.zu-stat-tip--' + variant + ' .zu-stat-k .zu-kpi-ico{flex:none!important;width:16px!important;height:16px!important;opacity:.85!important;align-self:center!important;vertical-align:initial!important}' +
          (variant === "today"
            ? /* v301 今日卡专属：缓存命中率副行柔和绿（输入格 dsub）；行内单格
               * （耗时字段缺失/费用关）占满整行不留空卡 */
              '.zu-stat-tip--today .zu-stat-dsub .hit{color:#4ade80!important;font-weight:600!important}' +
              '.zu-stat-tip--today .zu-turn-kpis .zu-stat-kpi:only-child{grid-column:1/-1!important}'
            : "") +
          (variant === "tools"
            ? /* v304 工具卡专属：表格定宽四列（名 43/次 18/耗时 25/错 14），长名省略
               * （title 全文），sticky 表头（区内滚表头恒可见），行 hover 轻提亮 */
              '.zusage-tip-root:has(.zu-stat-tip--tools) .zu-stat-title{display:flex!important;align-items:center!important;gap:8px!important}' +
              '.zu-stat-tip--tools .zu-stat-title .zu-kpi-ico{opacity:.9!important}' +
              '.zu-stat-tip--tools .zu-stat-table{table-layout:fixed!important;width:100%!important}' +
              '.zu-stat-tip--tools .zu-stat-table th:first-child,.zu-stat-tip--tools .zu-stat-table td:first-child{width:43%!important}' +
              '.zu-stat-tip--tools .zu-stat-table td.zu-pj-mname{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;max-width:none!important}' +
              '.zu-stat-tip--tools .zu-stat-table thead th{position:sticky!important;top:0!important;background:var(--color-tooltip,#171717)!important;z-index:1!important}' +
              '.zu-stat-tip--tools .zu-stat-table tbody tr:hover{background:var(--color-hover,rgba(255,255,255,.05))!important}' +
              '.zusage-tip-root.zu-light:has(.zu-stat-tip--tools) .zu-stat-table thead th{background:var(--color-tooltip,#f7f7f7)!important}'
            : "") +
          (variant === "project"
            ? /* v303 项目卡专属：旧分区 margin 交给 flex gap；模型表为 840px 宽卡设计，
               * 450px 下收紧内距；名称列上限同步收窄；展开按钮压缩 */
              '.zu-stat-tip--project .zu-pj-head{margin-bottom:0!important}' +
              '.zu-stat-tip--project .zu-pj-table th{padding:1px 3px 4px!important;white-space:nowrap!important}' +
              '.zu-stat-tip--project .zu-pj-table td{padding:3px!important;height:auto!important}' +
              '.zu-stat-tip--project .zu-pj-table td:first-child{max-width:150px!important}' +
              '.zu-stat-tip--project .zu-pj-more{margin:6px auto 0!important;padding:2px 10px!important;font-size:calc(var(--ui-font-size,14px) - 2px)!important}' +
              '.zu-stat-tip--project .zu-pj-title{display:flex!important;align-items:baseline!important;white-space:nowrap!important;min-width:0!important}' +
              '.zu-stat-tip--project .zu-pj-pname{overflow:hidden!important;text-overflow:ellipsis!important;flex:0 1 auto!important;min-width:0!important}'
            : "") +
          '</style>';
    }
    /* v303 提升到模块级：项目卡 buildProjectTipHTML（html() 外）也按长度取值分桶 */
    function turnVBkt(txt) {
      var n = (txt || "").length;
      return n > 14 ? " zu-turn-l2" : n > 10 ? " zu-turn-l1" : "";
    }
    function statKpi(k, vHtml, extraCls, sub) {
      /* v299：第四参 sub=KPI 辅助行 HTML（含思考挂到输出格下，不占第四列）；
       * v299.1：extraCls 改挂 .zu-stat-v（长度分桶缩字号锚在值元素上，此前挂外层
       * div 导致分桶 CSS 永不命中）；既有其它调用点均 ≤2 参，行为不变 */
      return '<div class="zu-stat-kpi"><div class="zu-stat-k">' + k + '</div><div class="zu-stat-v' + (extraCls ? " " + extraCls : "") + '">' + vHtml + '</div>' +
        (sub ? '<div class="zu-stat-dsub">' + sub + '</div>' : "") + '</div>';
    }
    function statDetail(k, dv, sub) {
      return '<div class="zu-pj-detail"><div class="zu-pj-k">' + ttEsc(k) + '</div><div class="zu-stat-dv">' + ttEsc(dv) + '</div>' +
        (sub ? '<div class="zu-stat-dsub">' + sub + '</div>' : '<div class="zu-stat-dsub"></div>') + '</div>';
    }
    function statTime(started, ended) {
      return '<div class="zu-pj-time"><b>' + ttEsc(L("时间范围", "Time span")) + '</b><span>' +
        (started ? fmtStartS(started) : "—") + " — " + (ended ? fmtStartS(ended) : "—") + '</span></div>';
    }
    function statTable(headers, rowsHtml) {
      return '<table class="zu-stat-table"><thead><tr>' + headers.map(function (h) { return '<th>' + ttEsc(h) + '</th>'; }).join("") + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>';
    }
    function hitPctOf(read, cached) {
      return (read > 0 && isFinite(read)) ? Math.round((cached || 0) / read * 100) : -1;
    }
    /* v202 本轮/今日 tooltip 的模型明细块（与会话/项目 rt-models 同构：token·次数·费用·?） */
    function modelsBlock(models) {
      return (models && models.length)
        ? '<div class="rt-models">' + models.map(function (m1) {
            return '<div class="rt-row"><b>' + ttEsc(m1.model || L("未知模型", "unknown")) + '</b><span>' +
              ttEsc(fmt(m1.total) + L(" token · ", " token · ") + countFmt(m1.requests || 0) + L("次", " req") +
                (state.cost && typeof m1.cost_usd === "number" ? L(" · ", " · ") + fmtMoney(m1.cost_usd) : "")) +
              (state.cost && typeof m1.cost_usd === "number" ? FXQ_ICON.replace('class="tip-fxq"', 'class="tip-fxq" data-model="' + escAttr(m1.model || "") + '"' + (m1.rates ? ' data-rates="' + escAttr(JSON.stringify(m1.rates)) + '"' : "")) : "") + "</span></div>";
          }).join("") + "</div>"
        : "";
    }
    /* v253 本轮/今日合计 tooltip 的「模型明细」表格（v288 起会话累计卡并入本实现；样式同项目累计统计卡：
     * zu-pj-mhead 标题 + 四列 zu-stat-table；数据同源 _scope_models_cost 已降序，
     * 此处对副本防御性重排不改快照原数组；费用列随 state.cost 门控、缺失显 "—"；
     * 空明细/旧快照缺字段整块不渲染。精简摘要的 rt-models 行式（modelsBlock）保留。 */
    function statModelsTable(models, headRight, tableOnly) {
      if (!models || !models.length) return "";
      var heads = [L("模型", "Model"), L("Token 用量 ↓", "Tokens ↓"), L("请求次数", "Requests")];
      if (state.cost) heads.push(L("预估费用", "Est. cost"));
      /* v299：headRight=表头行右侧自定义 HTML（本轮卡放工具调用次数；已转义/可信），
       * 缺省/空串维持「按用量排序」，会话/今日调用点不变；
       * tableOnly=只出表格（本轮卡标题行固定在滚动区外、表体独立滚动） */
      var head = tableOnly ? "" :
        '<div class="zu-pj-mhead"><div class="zu-pj-mtitle">' + ttEsc(L("模型明细", "Models")) + '</div><div class="zu-pj-morder">' + (headRight ? headRight : ttEsc(L("按用量排序", "by usage"))) + '</div></div>';
      return head +
        statTable(heads, models.slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); }).map(function (m1) {
          var name = m1.model || L("未知模型", "unknown");
          return '<tr>' +
            '<td class="zu-pj-mname" title="' + escAttr(name) + '">' + ttEsc(name) + '</td>' +
            '<td>' + ttEsc(fmt(m1.total || 0)) + '</td>' +
            '<td>' + ttEsc(countFmt(m1.requests || 0)) + '</td>' +
            (state.cost ? '<td>' + (typeof m1.cost_usd === "number" && isFinite(m1.cost_usd) ? ttEsc(fmtMoney(m1.cost_usd)) : "—") + '</td>' : "") +
            '</tr>';
        }).join(""));
    }
    /* v248：KPI 费用 ? 图标随卡携带模型上下文——data-model/data-rates=按用量最多模型、
     * data-mcount=模型数、data-mscope=计价范围名词（气泡多模型时显示「计价范围」行）。
     * 不再借快照根部 last（全局最近会话的模型，悬浮会话≠它时张冠李戴）；
     * 无模型明细（轻量行/旧快照/远端旧行）退回裸图标=气泡不显模型行。 */
    function fxqIcon(models, scopeText) {
      var ms = (models && models.length) ? models : null;
      if (!ms) return FXQ_ICON;
      var top = ms.slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); })[0] || {};
      return FXQ_ICON.replace('class="tip-fxq"', 'class="tip-fxq" data-model="' + escAttr(top.model || "") + '"' +
        (top.rates ? ' data-rates="' + escAttr(JSON.stringify(top.rates)) + '"' : "") +
        ' data-mcount="' + ms.length + '"' +
        (scopeText ? ' data-mscope="' + escAttr(scopeText) + '"' : ""));
    }
    /* v301 三张统计卡共用 KPI 图标：统一外框（16px / stroke 1.8 / currentColor /
     * aria-hidden）+ 路径表复用，避免多处维护相同 SVG 串。语义=层叠总量/输入下箭头/
     * 输出上箭头/时钟耗时/闪电延迟/循环重试/表盘速度/硬币费用 + v301.1 补齐本轮/
     * 会话卡：沙漏总耗时/气泡轮对话。色随文字（标签灰），不做高饱和装饰，不参与焦点。 */
    var KPI_ICON_PATHS = {
      total: '<path d="m12 3-9 5 9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
      input: '<path d="M12 3v13"/><path d="m7 11 5 5 5-5"/><path d="M4 21h16"/>',
      output: '<path d="M12 21V8"/><path d="m7 13 5-5 5 5"/><path d="M4 3h16"/>',
      duration: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      latency: '<path d="M13 2 4 13h7l-1 9 10-12h-7V2Z"/>',
      retry: '<path d="M20 11a8 8 0 1 0-2.3 5.6"/><path d="M20 4v7h-7"/>',
      speed: '<path d="M4.9 19a9 9 0 1 1 14.2 0"/><path d="m12 14 4-5"/><circle cx="12" cy="14" r="1"/>',
      cost: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
      elapsed: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
      turns: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
      requests: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
      tools: '<path d="M14.5 2.5a6 6 0 0 0-5.6 8.1L3.3 16.2a3.2 3.2 0 0 0 4.5 4.5l5.6-5.6a6 6 0 0 0 8.1-5.6l-4.1 3-3.8-3.8 3-4.1a6 6 0 0 0-2.1-2.1z"/>',
      sessions: '<path d="M7.5 3h12a2 2 0 0 1 2 2v10M4.5 7h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-5.5 2V9a2 2 0 0 1 2-2z"/>'
    };
    function kpiIco(name, size) {
      var s = size || 16;
      return '<svg class="zu-kpi-ico" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        (KPI_ICON_PATHS[name] || "") + '</svg>';
    }
    /* v97：live chip（生成速度）的 tooltip 内容——子代理速率是渲染端实时状态（不在泵
     * 快照里），html() 整条渲染与 updateLive 原地改字两条路径都要能生成，抽出共用。
     * 运行中的每个子代理一行（…sid4 · 估 X t/s），并行 ≥2 个时先给合计行。 */
    function buildLiveTip(speedView) {
      /* v215 速度统计卡 live 态：scope=生成中估算；主读数=状态词/估算值（speedView.cls
       * 档位色）；sub=最近一轮真实值。保留子代理槽位明细与两侧口径说明（各自真实口径）。
       * v232：快照带 speed_segs 时右列改画「最近 17 段」柱状图（最近一段由最新柱承载，
       * sub 右格只在无图表的旧快照回退布局保留），柱级悬停/焦点经 speedTipRebuild 重建。 */
      var isTool = speedView && speedView.phase === "tool";
      var isThink = speedView && speedView.phase === "thinking";
      var mainText = speedView ? speedView.text : "—";
      var mainCls = speedView && speedView.cls ? speedView.cls : "";
      var noUnit = isTool || isThink || !speedView || typeof speedView.rate !== "number";
      var segs = speedSegsOf(lastView && lastView.session);
      var hasChart = !!(segs && segs.length);
      var segSess = (lastView && lastView.session && lastView.session.sid) || "";
      if (speedTipSess !== segSess) {   // 会话切换：v240 起回未悬停；v254 筛选态一并复位，不串上一 pane 的选择
        speedTipSess = segSess; speedChartHover = -1;
        if (typeof speedSel !== "undefined" && speedSel) {
          speedSel.range = "recent"; speedSel.period = "recent"; speedSel.dim = "time"; speedSel.focus = "";
        }
      }
      /* v218 修复：zuBarSpeedView 从不返回 latest 字段，右格恒缺（用户实测「缺少最近
       * 一段的生成速度」）。改取泵快照最近一段真实值（last.tps，与 fallback 完成态
       * 右格同口径、同文案「最近一段」）。v232：有图表时该读数由最新柱承载。 */
      var subLabel = "", subVal = "";
      var dbTps3 = (lastView && lastView.last && typeof lastView.last.tps === "number" &&
        isFinite(lastView.last.tps) && lastView.last.tps > 0) ? lastView.last.tps : 0;
      if (dbTps3 && !hasChart) {
        subLabel = L("最近一段", "Latest segment");
        subVal = (dbTps3 % 1 ? dbTps3.toFixed(1) : String(dbTps3));
      }
      /* v222：时间范围行取会话累计口径（lastView.session，与会话累计 tooltip 同源）；
       * 会话起点缺失（远端轻量行/旧快照）整行不渲染。 */
      var liveSpan = speedSpan(lastView && lastView.session ? lastView.session.started : 0,
                               lastView && lastView.session ? lastView.session.last_at : 0);
      var basisText = [];
      if (speedView && speedView.phase) {
        basisText.push(L("按文本增量算出的字符/s，除以「每 token 字符数」估算 tok/s；该比例取自本会话最近一次完成的真实轮次，随每轮刷新（首轮无样本时用粗略默认值）",
          "estimated from the text-delta chars/s divided by a chars-per-token ratio; the ratio is calibrated from this session's most recently completed turn and refines each turn (a rough default is used before the first sample)"));
        basisText.push(L("子智能体运行期间按各自会话文本增量同款估算，主 chip 显示合计；运行中的请求未入本地库，思考文本不外显时无速率、只显示状态词",
          "while sub-agents run, each is estimated the same way from its own session text deltas and the bar chip shows their sum; in-flight requests are not in the local DB yet, and when thinking text is not exposed there is no rate, only the status word"));
      } else {
        basisText.push(speedView && speedView.kind === "avg"
          ? L("Σ输出（含思考）÷ 生成耗时", "Σoutput (thinking incl.) ÷ generation time")
          : L("本轮完成 · 真实值：输出 tokens（含思考）÷ 模型生成时长；本轮缺口径时回退数据库最近一段值",
          "Turn completed · actual: output tokens (thinking incl.) ÷ model generation time; falls back to the latest DB segment when this turn's basis is missing"));
      }
      if (hasChart) {
        basisText.push(L("最近 10 轮：每轮（一次提问的全部模型请求）按 Σ有效输出 ÷ Σ生成耗时加权的真实速度，按完成顺序从旧到新展示；工具等待不计，不含子代理。",
          "Last 10 turns: weighted real speed of each completed turn (all its model requests, Σrated output ÷ Σgeneration time), oldest → newest; tool waits excluded, sub-agents excluded."));
      }
      function extraHtml() {
        var out = "";
        if (isTool) {
          var sids = [], now = Date.now();
          for (var sid in subRate.slots) sids.push(sid);
          sids.sort();
          var fresh = 0;
          for (var i = 0; i < sids.length; i++) {
            var sl = subRate.slots[sids[i]];
            if (sl.rate != null && now - sl.at <= 3000) fresh++;
          }
          if (sids.length) {
            if (fresh > 1) out += '<div class="zu-stat-note">' + escHtml(L("合计 估 ", "Sum est ") + subRate.sum.rate.toFixed(1) + L(" t/s（", " t/s (") + fresh + L(" 个）", " running)")) + '</div>';
            for (var j = 0; j < sids.length; j++) {
              var s2 = subRate.slots[sids[j]];
              var tail = String(sids[j]).slice(-4);
              out += '<div class="zu-stat-note">' + escHtml(L("子代理 …" + tail + " ", "agent …" + tail + " ") +
                (s2.rate != null && now - s2.at <= 3000 ? L("估 ", "est ") + s2.rate.toFixed(1) + L(" t/s", " t/s") : L("估算中…", "estimating…"))) + '</div>';
            }
          }
        }
        return out;
      }
      var foot = [L("数据来自 renderer 会话状态（只读桥），实时更新，不经过本地数据库轮询；生成中的数值为字符增量估算", "Data comes from the renderer session state via the read-only bridge, updating live, independent of local database polling; running values are estimated from text deltas")];
      /* v235：结构化状态直传（zuBarSpeedView 的 kind/statusText/…），思考态注入脑图标；
       * scope 标签按真实状态映射，不再一律写「生成中估算」——完成态标会话平均/本轮
       * 真实速度，工具/组/Skill/子代理/思考各归其位。 */
      var liveScopeMap = {
        tool: L("工具执行中", "Tool running"),
        toolgroup: L("工具组执行中", "Tool group running"),
        skill: L("Skill 执行中", "Skill running"),
        subagent: L("子代理运行中", "Sub-agents running"),
        thinking: L("思考中", "Thinking"),
        estimate: L("生成中（估算）", "Generating (est.)"),
        avg: L("会话平均", "Session average"),
        real: L("本轮实际速度", "Actual speed this turn")
      };
      var liveScope = speedView && speedView.kind && liveScopeMap[speedView.kind]
        ? liveScopeMap[speedView.kind]
        : (speedView && speedView.phase ? L("生成中估算", "Running estimate") : L("本轮完成 · 真实值", "Turn completed · actual"));
      var liveStatus = null;
      if (speedView && speedView.kind) {
        liveStatus = speedView;
        if (speedView.kind === "thinking") liveStatus.iconHTML = zuIcoThinking();
      }
      var opts = {
        scope: liveScope,
        status: liveStatus,
        main: mainText,
        mainCls: mainCls,
        noUnit: noUnit,
        subLabel: subLabel,
        sub: subVal,
        bandTag: speedView && speedView.band ? tpsBandText(speedView.band) : "",
        curCls: speedView && speedView.band ? speedView.cls : "",
        basisTitle: L("统计口径", "Basis"),
        basisText: basisText,
        timeStart: liveSpan ? liveSpan.start : "",
        timeEnd: liveSpan ? liveSpan.end : "",
        foot: foot,
        segs: segs,
        segsHover: speedChartHover,
        /* v250：悬停信息卡轮明细的格式化回调（bandHelpers 切片不可达本闭包）；费用行
         * 随 state.cost 门控（关时不传 fmtMoney → 明细行不带预估费用） */
        fmtTok: fmt,
        fmtCnt: countFmt,
        fmtMoney: state.cost ? fmtMoney : null
      };
      /* v232：柱级悬停/焦点改悬停段下标后经此闭包整卡重建（串里已带 cur/信息卡状态，
       * 与 updateLive 每写回 __tip 的链路同源；下一 tick 的 buildLiveTip 会覆盖闭包）。 */
      var v2selL = (typeof speedSel !== "undefined" && speedSel) ? speedSel
        : { range: "recent", period: "recent", dim: "time" };
      /* v268：帧缺轮表（serve 重启窗口）时以粘性兜底，杜绝 V2↔旧版闪回 */
      var v2h = (state.data && state.data.speed_history) ||
        (typeof lastSpeedHistory !== "undefined" && lastSpeedHistory) || null;
      var v2sess = (lastView && lastView.session) || {};
      speedTipRebuild = (typeof spdRebuildOr === "function"
        ? spdRebuildOr(v2h, v2selL, speedChartHover, speedView,
          { fmtTok: fmt, fmtCnt: countFmt, fmtMoney: state.cost ? fmtMoney : null }, v2sess) : null);
      /* v258 帧级诊断：V2 成功/回退各记一条 spdTip——再出现「样式变回旧版」时 diag 直接
       * 给出走哪条路径与当时轮表长度，不再靠截图反推。原地更新属性，不替换 FATAL 本体。
       * v261：spdTip 带 pane 标识（多实例共享 diag，无标识无法分清是哪个实例写的）。 */
      if (speedTipRebuild) {
        try { FATAL.spdTip = { t: Date.now(), src: "v2-live", pane: pid,
          turns: v2h && v2h.turns ? v2h.turns.length : -1 }; } catch (_) { }
      } else {
        try { FATAL.spdTip = { t: Date.now(), src: "fb-live", pane: pid,
          turns: v2h && v2h.turns ? v2h.turns.length : -1,
          range: v2selL && v2selL.range, period: v2selL && v2selL.period,
          sid: String((v2sess && v2sess.sid) || "").slice(-8) }; } catch (_) { }
        speedTipRebuild = function () {
          opts.segsHover = speedChartHover;
          return '\x01' + speedCardHTML(opts) + extraHtml() + '</div>';
        };
      }
      return speedTipRebuild(speedChartHover, v2selL);
      function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    }
    /* 行内 SVG 线性图标（v54）：stroke 走 currentColor，颜色由 .ico 控制统一换色 */
    function ico(paths) {
      return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    }
    function html(d) {
      var sess = d.session || {}, lt = d.last_turn || {}, today = d.today || {}, last = d.last || {};
      var tls = d.tools || { total: 0, errors: 0, list: [] };
      var items = [], tips = [];
      function it(inner, tipContent, cls) {
        var interactive = cls === "zu-sub";
        items.push('<' + (interactive
          ? 'button type="button" aria-label="' + L("子代理", "Sub-agents") + '"'
          : 'span tabindex="0"') +
          ' class="it' + (cls ? " " + cls : "") + '">' + inner + (interactive ? "</button>" : "</span>"));
        tips.push(tipContent || null);
      }
      if (d.remote) {   // v9：SSH 远程会话（数据取自远端机），置顶徽标标明数据源
        it(ico('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>') +
          '<span class="dim">' + L("远端", "remote") + "</span>",
          L("数据源：SSH 远程服务器 ", "Data source: remote server over SSH ") + (d.remote_host || "?") + "\n" +
          L("会话数据实时取自远端机的 ZCode 数据库，「今日合计」亦为远端值", "Session data is fetched live from the remote machine's ZCode database; today's total is the remote value") +
          (d.remote_error ? "\n⚠ " + L("最近一次远端查询失败：", "Last remote query failed: ") + d.remote_error : "") +
          (d.remote_stale ? "\n" + L("当前显示最后成功快照，正在重试", "Showing last successful snapshot; retrying") : "") +
          (d.remote_empty ? "\n⚠ " + L("远端库里这个会话还没有已完成的请求（各项为 0）——确认远端 zusage.py 读到的库与远端 ZCode 实际写入的库是同一个",
                                        "The remote database has no completed requests for this session (all items are 0) — check that the remote zusage.py reads the same database the remote ZCode actually writes") : ""));
      }
      if (d.not_local) {   // v62（issue #14）：本地库没有这个会话 —— 全 0 不是插件坏了，是数据不在这儿
        it(ico('<circle cx="12" cy="12" r="9"/><path d="M12 16h.01"/><path d="M12 8h.01"/>') +
          '<span class="dim">' + L("不在本地库", "not in local db") + "</span>",
          L("这个会话不在本地数据库里（~/.zcode/cli/db/db.sqlite 查不到它），所以各项显示 0 —— 不是插件坏了。",
            "This session is not in the local database (~/.zcode/cli/db/db.sqlite), which is why every item reads 0 — the plugin is not broken.") + "\n" +
          (d.remote_enabled
            ? L("已配置 remote 段，但远端查询没有返回它：", "A remote section is configured, but the remote query did not return it: ")
              + (d.remote_error ? L("查询失败 ", "query failed: ") + d.remote_error
                 : L("远端库里也没有这个会话（核对远端 zusage.py 读的库/用户与远端 ZCode 实际写入的是否一致）",
                     "the remote database does not have it either (verify the database/user the remote zusage.py reads matches what the remote ZCode writes)"))
            : L("若这是 SSH/WSL 远程会话：客户端连过的远端工作区会自动被发现并查询（零配置）；没查到时核对远端已部署 zusage.py（WSL 需发行版内有 python3），或在 config.json 配置 remote 段（README「远程会话」；ssh 也可写成 argv 数组，docker exec / wsl --exec / kubectl exec 等通道都能借道）",
                "If this is a remote SSH/WSL session: remote workspaces the client connected to are discovered and queried automatically (zero config); if it's still missing, make sure zusage.py is deployed on the remote machine (WSL needs python3 inside the distro), or add the remote section to config.json (see README; ssh may also be an argv array, so docker exec / wsl --exec / kubectl exec all work)")));
      }
      /* v73：生成速度——桥命中（本 pane 会话有 renderer 投影）时用它的估算/真实 tok/s，
       * 否则退回原 DB 最近一段值（与 state.rateLine 开关无关：桥不可用或开关关闭时
       * liveStatsCur 恒为空，自动走 db 分支，不影响这个本就独立于逐问速率行的指标）。
       * zuBarSpeedView 对"刚绑定/重绑时捞到的历史存量已完成轮次"返回 null——这种情况
       * 和"桥完全没命中"一视同仁，同样回退 DB/不渲染，不冒充"这个会话速度不可用"。
       * 二者互斥：绝不同时渲染两枚「速度」chip。 */
      var dbTps = last.tps || 0;
      var sessAvg = (sess && typeof sess.avg_tps === "number" && isFinite(sess.avg_tps) && sess.avg_tps > 0) ? sess.avg_tps : 0;
      var speedView = liveStatsCur ? zuBarSpeedView(liveStatsCur, bridge.handle && bridge.handle.charsPerToken, subRate.sum, sessAvg) : null;
      if (speedView) {
        liveKindCur = "live";
        livePhaseCur = speedView.phase || "";
        liveIconCur = speedView.phase === "thinking" ? "think" : speedView.phase === "tool" ? "tool" : speedView.phase ? "generate" : "bolt";
        it((speedView.phase === "thinking" ? zuIcoThinking()
          : speedView.phase === "tool" ? ico('<path d="M14.5 2.5a6 6 0 0 0-5.6 8.1L3.3 16.2a3.2 3.2 0 0 0 4.5 4.5l5.6-5.6a6 6 0 0 0 8.1-5.6l-4.1 3-3.8-3.8 3-4.1a6 6 0 0 0-2.1-2.1z"/>')
          : ico('<path d="M13.5 2 3.5 13.5H11L10 22l10.5-12H13l.5-8z"/>')) +
          '<span class="zu-live ' + speedView.cls + (speedView.word ? " zu-shimmer" : "") + '">' + ttEsc(speedView.text) + "</span>",
          buildLiveTip(speedView));
      } else if ((sessAvg || dbTps) && isFinite(sessAvg || dbTps) && (sessAvg || dbTps) > 0) {
        /* v127：负数/±Infinity 是异常数据，按无数据处理（整枚 chip 不渲染，与
         * NaN/0 一致），绝不判成低速；正有限值按 TPS_BANDS 分档，档位行动态显示。
         * 有会话平均时主数字 = 会话平均（与桥完成态同口径），最近一段退到 tooltip。 */
        liveKindCur = "fallback";
        livePhaseCur = "";
        liveIconCur = "bolt";
        /* v298（用户拍板）：chip 条面=最后一轮真实速度（chipTps）；tooltip V1 回退卡
         * 仍按会话均优先（mainTps 原语义不变）——两处取值分离。最近一段无有效值
         * 时面留空且不渲染 t/s 单位（与 11 分片精简 chip 拍板语义一致：无最后一轮
         * 不显会话均），绝不把无效样本渲染成 0 t/s（review 修复，§5 口径） */
        var chipTps = dbTps;
        var mainTps = sessAvg || dbTps;
        var tband = tpsBand(mainTps);
        var speedTm = sessAvg ? speedSpan(sess.started, sess.last_at) : speedSpan(last.startedAt, last.endedAt);   // v222 时间范围行
        /* v232：最近 17 段柱状图（快照 speed_segs，Python 侧 avg_tps 同款口径）。
         * 会话切换重置悬停段；有图表时「最近一段」右格由最新柱承载。 */
        var fbSegs = speedSegsOf(sess);
        var fbHasChart = !!(fbSegs && fbSegs.length);
        var fbSess = sess.sid || "";
        if (speedTipSess !== fbSess) {
          speedTipSess = fbSess; speedChartHover = -1;
          if (typeof speedSel !== "undefined" && speedSel) {
          speedSel.range = "recent"; speedSel.period = "recent"; speedSel.dim = "time"; speedSel.focus = "";
        }
        }
        var fbBasis = sessAvg
          ? [L("Σ输出（含思考）÷ 生成耗时", "Σoutput (thinking incl.) ÷ generation time")]
          : [L("输出 tokens（含思考）÷ 生成耗时", "output tokens (thinking incl.) ÷ generation time")];
        if (fbHasChart) {
          fbBasis.push(L("最近 10 轮：每轮（一次提问的全部模型请求）按 Σ有效输出 ÷ Σ生成耗时加权的真实速度，按完成顺序从旧到新展示；工具等待不计，不含子代理。",
            "Last 10 turns: weighted real speed of each completed turn (all its model requests, Σrated output ÷ Σgeneration time), oldest → newest; tool waits excluded, sub-agents excluded."));
        }
        var fbFoot = [L("每段完成后刷新：回复末尾为整问加权均值，数值不同属正常。", "Refreshes as each segment completes: the reply-end line is the whole-turn weighted average and legitimately differs.")];
        var fbOpts = {
          scope: sessAvg ? L("会话平均", "Session average") : L("最近一段", "Latest segment"),
          status: { kind: sessAvg ? "avg" : "real",
            statusText: L("生成完成", "Generation complete"),
            speedValue: mainTps, speedIsEstimated: false,
            speedSource: sessAvg ? "avg" : "real", band: tband,
            noteText: sessAvg ? L("会话加权平均", "Weighted average")
              : L("最近一段 · 实际值", "Latest segment · actual") },
          main: (mainTps % 1 ? mainTps.toFixed(1) : String(mainTps)),
          mainCls: tband.cls,
          subLabel: (!fbHasChart && sessAvg && dbTps > 0) ? L("最近一段", "Latest segment") : "",
          sub: (!fbHasChart && sessAvg && dbTps > 0) ? (dbTps % 1 ? dbTps.toFixed(1) : String(dbTps)) : "",
          bandTag: tpsBandText(tband),
          curCls: tband.cls,
          basisTitle: L("统计口径", "Basis"),
          basisText: fbBasis,
          foot: fbFoot,
          timeStart: speedTm ? speedTm.start : "",
          timeEnd: speedTm ? speedTm.end : "",
          segs: fbSegs,
          segsHover: speedChartHover,
          fmtTok: fmt,
          fmtCnt: countFmt,
          fmtMoney: state.cost ? fmtMoney : null   // v250：悬停卡轮明细格式化回调（费用随 state.cost 门控）
        };
        /* v254：有统一轮表时整卡改走 V2（筛选/16 柱/五字段 hover），旧快照回退原布局。
         * 用纯函数桥 spdRebuildOr（切片夹具内也可达）；speedSel 在 VM 夹具里不存在时
         * 按默认筛选，不影响旧契约断言。 */
        var v2sel = (typeof speedSel !== "undefined" && speedSel) ? speedSel
          : { range: "recent", period: "recent", dim: "time" };
        var v2fn = (typeof spdRebuildOr === "function"
          ? spdRebuildOr(d.speed_history ||
            (typeof lastSpeedHistory !== "undefined" && lastSpeedHistory), v2sel, speedChartHover, null,
            { fmtTok: fmt, fmtCnt: countFmt, fmtMoney: state.cost ? fmtMoney : null }, sess) : null);
        /* v261：整条渲染专记 spdRender（updateLive 每 tick 的 v2-live 会覆盖 spdTip，
         * 用户 hover 瞬间的整条渲染记录必须独立存活）；带 pane/会话标识与分支原因。 */
        var spdSID8 = String(sess.sid || "").slice(-8);
        if (v2fn) {
          try { FATAL.spdRender = { t: Date.now(), src: "v2-html", pane: pid, sid: spdSID8,
            turns: d.speed_history && d.speed_history.turns ? d.speed_history.turns.length : -1,
            range: v2sel.range, period: v2sel.period, dim: v2sel.dim }; } catch (_) { }
          speedTipRebuild = v2fn;
        } else {
          try { FATAL.spdRender = { t: Date.now(), src: "fb-html", pane: pid, sid: spdSID8,
            turns: d.speed_history && d.speed_history.turns ? d.speed_history.turns.length : -1,
            hasH: !!d.speed_history, range: v2sel.range, period: v2sel.period }; } catch (_) { }
          try { FATAL.spdTip = { t: Date.now(), src: "fb-html", pane: pid,
            turns: d.speed_history && d.speed_history.turns ? d.speed_history.turns.length : -1,
            range: v2sel.range, period: v2sel.period, sid: String(sess.sid || "").slice(-8) }; } catch (_) { }
          speedTipRebuild = function () {
            fbOpts.segsHover = speedChartHover;
            return "\x01" + speedCardHTML(fbOpts);
          };
        }
        /* v298（用户拍板）：chip 主数字=最后一轮真实速度（最近一段，不再取会话均、
         * 不带「均」前缀）；tooltip 左卡仍为会话加权平均（"平均速度"语义不变） */
        var chipBand = tpsBand(chipTps);
        var chipFace = chipTps > 0 ? ((chipTps % 1 ? chipTps.toFixed(1) : String(chipTps)) + ' <span class="dim">t/s</span>') : "";   // 最后一轮无效：面空（含单位），仅留图标作悬停锚；空面补 aria-label 保可访问名（review 修复）。v319：数字与单位间补空格（原串无空格、.zu-live 的 word-spacing 对无空格文本无效，真机实测数字紧贴 t/s；补空格后与实时桥路径「 t/s」+word-spacing:2px 渲染一致）
        it(ico('<path d="M13.5 2 3.5 13.5H11L10 22l10.5-12H13l.5-8z"/>') +
          '<span class="zu-live ' + (chipBand ? chipBand.cls : "dim") + '"' + (chipFace ? "" : ' aria-label="' + L("生成速度", "Generation speed") + '"') + '>' + chipFace + '</span>',
          speedTipRebuild(speedChartHover, v2sel));
      } else {
        liveKindCur = "none";
        livePhaseCur = "";
        liveIconCur = "";
      }
      /* v299 本轮卡辅助：模型标题行右侧串（工具调用/重试/错误，原 scale 行内容迁此）；
       * 值长度分档（>10 字符降 1 档、>14 降 2 档）——固定 500px 列宽下的防溢出缩字 */
      var turnToolsHtml = (lt.tool_calls || lt.retries || lt.tool_errors)
        ? [(lt.tool_calls ? ttEsc(L("工具调用 ", "tools ") + countFmt(lt.tool_calls) + L(" 次", " calls")) : ""),
           (lt.retries ? ttEsc(L("重试 ", "retries ") + countFmt(lt.retries) + L(" 次", " times")) : ""),
           (lt.tool_errors ? ttEsc(L("错误 ", "errors ") + countFmt(lt.tool_errors) + L(" 次", " times")) : "")].filter(Boolean).join('<i class="zu-turn-sep">·</i>')
        : "";
      if (state.show.turn) {
        it(ico('<path d="M5 3.5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9l-6.5 4V5.5a2 2 0 0 1 1.5-2z"/><path d="M7.5 8.5h9m-9 4h6"/>') +
          '<span class="v">' + fmt(lt.total) + "</span>" +
          (state.theme === "pill" ? "" :
            (shrink ? "" : "") +
            '<span class="dim">' + countFmt(lt.requests || 0) + L("次", " req") + "</span>"),
          /* v211 格面移除单次耗时/首字延迟段（用户规格）：耗时/延迟只在 tooltip 呈现
           * （平均耗时/平均延迟，对全体请求求均值） */
          /* v299 500×350 紧凑布局（用户 /goal）：三行 KPI 固定顺序——
           * ①总用量|输入(缓存命中)|输出(含思考) ②请求次数|请求轮数|请求会话
           * ③平均耗时|平均延迟|总耗时 ④平均输出速度(档位色文字强调)|预估费用；
           * 工具调用并入模型明细标题行右侧；
           * 模型表独立滚动区（主 tooltip 无滚动条）；时间范围钉底。
           * 样式全部经内联 <style> 以 :has(.zu-stat-tip--turn) 作用域——只影响本轮卡，
           * 会话/今日/项目/工具/速度卡与共享 .zu-stat-* 规则零波及（速度卡同款先例）。 */
          "\x01" +
          statCompactStyle("turn") +
          '<div class="zu-stat-tip zu-stat-tip--turn">' +
          statHead(L("本轮", "Latest turn"), countFmt(lt.requests || 0) + L(" 次请求", " requests")) +
          /* 行一：总用量 | 输入（缓存命中辅助行）| 输出（含思考辅助行） */
          '<div class="zu-turn-kpis">' +
            statKpi(kpiIco("total") + L("总用量", "Total tokens"), ttEsc(fmt(lt.total || 0)), turnVBkt(fmt(lt.total || 0))) +
            /* v299.1（用户规格）：缓存命中率改「缓存 N%」，放「输入」标签行右侧
             * （statKpi 的 k 为 raw HTML；标签行短，徽标空间充裕不再截断） */
            statKpi(kpiIco("input") + L("输入", "Input") +
              (hitPctOf(lt.input, lt.cache_read) >= 0 ? '<span class="hit zu-turn-hit">' + ttEsc(L("缓存", "cache ") + hitPctOf(lt.input, lt.cache_read) + "%") + '</span>' : ""),
              ttEsc(fmt(lt.input || 0)), turnVBkt(fmt(lt.input || 0))) +
            statKpi(kpiIco("output") + L("输出", "Output"), ttEsc(fmt(lt.output || 0)), turnVBkt(fmt(lt.output || 0)),
              (lt.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(lt.reasoning)) : "")) +
          '</div>' +
          /* 行二（v302 用户规格）：请求规模层级——请求次数（本轮模型请求）|
           * 请求轮数（本轮所属会话累计轮数 sess.turns）| 请求会话（所属项目累计会话数
           * sess.project.sessions，项目字段缺失诚实显 —，不伪造 1） */
          '<div class="zu-turn-kpis">' +
            statKpi(kpiIco("requests") + L("请求次数", "Requests"), ttEsc(countFmt(lt.requests || 0)), turnVBkt(countFmt(lt.requests || 0))) +
            statKpi(kpiIco("turns") + L("请求轮数", "Turns"), ttEsc(countFmt(sess.turns || 0)), turnVBkt(countFmt(sess.turns || 0))) +
            statKpi(kpiIco("sessions") + L("请求会话", "Sessions"),
              ((sess.project && typeof sess.project.sessions === "number")
                ? ttEsc(countFmt(sess.project.sessions)) : "—"), turnVBkt(
              (sess.project && typeof sess.project.sessions === "number") ? countFmt(sess.project.sessions) : "—")) +
          '</div>' +
          /* 行三：平均耗时 | 平均延迟 | 总耗时（沿用 >0 门控，缺字段不伪造 0s；v302 改名「总耗时」） */
          ((lt.avg_duration_ms > 0 || lt.avg_ttft_ms > 0 || lt.duration_ms > 0)
            ? '<div class="zu-turn-kpis zu-turn-kpis--mid">' +
              (lt.avg_duration_ms > 0 ? statKpi(kpiIco("duration") + L("平均耗时", "Avg time"), ttEsc(sec(lt.avg_duration_ms)), turnVBkt(sec(lt.avg_duration_ms))) : "") +
              (lt.avg_ttft_ms > 0 ? statKpi(kpiIco("latency") + L("平均延迟", "Avg TTFT"), ttEsc(sec(lt.avg_ttft_ms)), turnVBkt(sec(lt.avg_ttft_ms))) : "") +
              (lt.duration_ms > 0 ? statKpi(kpiIco("elapsed") + L("总耗时", "Total time"), ttEsc(sec(lt.duration_ms)), turnVBkt(sec(lt.duration_ms))) : "") +
              '</div>' : "") +
          /* 行四（v302 用户规格改名「平均输出速度」，与本轮内加权口径一致）：
           * TPS_BANDS 档位色文字，无背景强调 | 预估费用（问号图标沿用）；
           * 费用关/缺失时速度格 only-child 占满整行，不留空卡 */
          '<div class="zu-turn-kpis zu-turn-kpis--duo">' +
            ((typeof lt.tps === "number" && isFinite(lt.tps) && lt.tps > 0)
              ? statKpi(kpiIco("speed") + L("平均输出速度", "Avg output rate"), '<b class="' + tpsBand(lt.tps).cls + '">' + ttEsc(lt.tps.toFixed(1)) + '</b> <small>t/s</small>')
              : statKpi(kpiIco("speed") + L("平均输出速度", "Avg output rate"), "—")) +
            ((state.cost && typeof lt.cost_usd === "number" && isFinite(lt.cost_usd))
              ? statKpi(kpiIco("cost") + L("预估费用", "Est. cost") + fxqIcon(lt.models, L("本轮", "this turn")), ttEsc(fmtMoney(lt.cost_usd)))
              : "") +
          '</div>' +
          /* 模型明细：工具调用/重试/错误并入标题行右侧（原独立 scale 行删除）；
           * 标题行固定、表格进独立滚动区——多模型超高处区内滚，主 tooltip 无滚动条、
           * 时间行不挤出、首行模型恒可见 */
          ((lt.models && lt.models.length)
            ? '<div class="zu-pj-mhead"><div class="zu-pj-mtitle">' + ttEsc(L("模型明细", "Models")) + '</div><div class="zu-pj-morder">' +
              (turnToolsHtml ? turnToolsHtml : ttEsc(L("按用量排序", "by usage"))) + '</div></div>' +
              '<div class="zu-turn-models">' + statModelsTable(lt.models, null, true) + '</div>'
            : "") +
          '<div class="zu-stat-time">' +
            '<b>' + ttEsc(L("时间范围", "Time span")) + '</b>' +
            '<span>' + ((lt.started || lt.ended)
              ? (lt.started ? fmtStartS(lt.started) : "—") + " — " + (lt.ended ? fmtStartS(lt.ended) : "—")
              : "—") + '</span>' +
          '</div>' +
          '</div>');
      }
      if (state.show.win) {
        it(ico('<path d="M7.5 3h12a2 2 0 0 1 2 2v10M4.5 7h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-5.5 2V9a2 2 0 0 1 2-2z"/>') +
          '<span class="v">' + fmt(sess.total) + "</span>" +
          (state.theme === "pill" ? "" :
            (shrink ? "" : "") +
            '<span class="dim">' + countFmt(sess.turns || 0) + L("轮 ", " turns · ") + countFmt(sess.requests || 0) + L("次", " req") + "</span>"),
          "\x01" + statCompactStyle("session") +
          '<div class="zu-stat-tip zu-stat-tip--session">' +
          statHead(L("会话累计", "Session total"), L("全部请求", "All requests"),
            ((sess.title || "").trim() ? '<span class="zu-st-name">' + ttEsc(String(sess.title).replace(/\s+/g, " ").trim()) + '</span>' : "")) +
          /* v300 行一：总用量 | 输入（缓存 N% 徽标随标签右侧）| 输出（含思考辅助行） */
          '<div class="zu-turn-kpis">' +
            statKpi(kpiIco("total") + L("总用量", "Total tokens"), ttEsc(fmt(sess.total || 0)), turnVBkt(fmt(sess.total || 0))) +
            statKpi(kpiIco("input") + L("输入", "Input") +
              (hitPctOf(sess.input, sess.cache_read) >= 0 ? '<span class="hit zu-turn-hit">' + ttEsc(L("缓存", "cache ") + hitPctOf(sess.input, sess.cache_read) + "%") + '</span>' : ""),
              ttEsc(fmt(sess.input || 0)), turnVBkt(fmt(sess.input || 0))) +
            statKpi(kpiIco("output") + L("输出", "Output"), ttEsc(fmt(sess.output || 0)), turnVBkt(fmt(sess.output || 0)),
              (sess.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(sess.reasoning)) : "")) +
          '</div>' +
          /* 行二（v302 用户规格，同本轮卡口径）：请求次数（本会话累计请求）|
           * 请求轮数（本会话累计轮数）| 请求会话（所属项目累计会话数，缺失诚实显 —） */
          '<div class="zu-turn-kpis">' +
            statKpi(kpiIco("requests") + L("请求次数", "Requests"), ttEsc(countFmt(sess.requests || 0)), turnVBkt(countFmt(sess.requests || 0))) +
            statKpi(kpiIco("turns") + L("请求轮数", "Turns"), ttEsc(countFmt(sess.turns || 0)), turnVBkt(countFmt(sess.turns || 0))) +
            statKpi(kpiIco("sessions") + L("请求会话", "Sessions"),
              ((sess.project && typeof sess.project.sessions === "number")
                ? ttEsc(countFmt(sess.project.sessions)) : "—"), turnVBkt(
              (sess.project && typeof sess.project.sessions === "number") ? countFmt(sess.project.sessions) : "—")) +
          '</div>' +
          /* 行三：会话级耗时（v300 zusage 聚合；旧快照缺字段按 >0 门控整行收起，不伪造；
           * v302 改名「总耗时」，secLong 换算保留） */
          ((sess.avg_duration_ms > 0 || sess.avg_ttft_ms > 0 || sess.duration_ms > 0)
            ? '<div class="zu-turn-kpis zu-turn-kpis--mid">' +
              (sess.avg_duration_ms > 0 ? statKpi(kpiIco("duration") + L("平均耗时", "Avg time"), ttEsc(sec(sess.avg_duration_ms)), turnVBkt(sec(sess.avg_duration_ms))) : "") +
              (sess.avg_ttft_ms > 0 ? statKpi(kpiIco("latency") + L("平均延迟", "Avg TTFT"), ttEsc(sec(sess.avg_ttft_ms)), turnVBkt(sec(sess.avg_ttft_ms))) : "") +
              (sess.duration_ms > 0 ? statKpi(kpiIco("elapsed") + L("总耗时", "Total time"), ttEsc(secLong(sess.duration_ms)), turnVBkt(secLong(sess.duration_ms))) : "") +
              '</div>' : "") +
          /* 行四（v302 用户规格）：平均输出速度（会话均 avg_tps，TPS_BANDS 档色文字）|
           * 预估费用；轮对话已并入行二「请求轮数」，本行改两列 */
          '<div class="zu-turn-kpis zu-turn-kpis--duo">' +
            ((typeof sess.avg_tps === "number" && isFinite(sess.avg_tps) && sess.avg_tps > 0)
              ? statKpi(kpiIco("speed") + L("平均输出速度", "Avg output rate"), '<b class="' + tpsBand(sess.avg_tps).cls + '">' + ttEsc(sess.avg_tps.toFixed(1)) + '</b> <small>t/s</small>')
              : statKpi(kpiIco("speed") + L("平均输出速度", "Avg output rate"), "—")) +
            ((state.cost && typeof sess.cost_usd === "number" && isFinite(sess.cost_usd))
              ? statKpi(kpiIco("cost") + L("预估费用", "Est. cost") + fxqIcon(sess.models, L("本会话", "this session")), ttEsc(fmtMoney(sess.cost_usd)))
              : "") +
          '</div>' +
          /* 工具调用/重试在模型明细标题行右侧（同本轮 v299 样式）；规模行已并入行三第一列 */
          ((sess.models && sess.models.length)
            ? '<div class="zu-pj-mhead"><div class="zu-pj-mtitle">' + ttEsc(L("模型明细", "Models")) + '</div><div class="zu-pj-morder">' +
              ((sess.tool_calls || sess.retries || sess.tool_errors)
                ? [(sess.tool_calls ? ttEsc(L("工具调用 ", "tools ") + countFmt(sess.tool_calls) + L(" 次", " calls")) : ""),
                   (sess.retries ? ttEsc(L("重试 ", "retries ") + countFmt(sess.retries) + L(" 次", " times")) : ""),
                   (sess.tool_errors ? ttEsc(L("错误 ", "errors ") + countFmt(sess.tool_errors) + L(" 次", " times")) : "")].filter(Boolean).join('<i class="zu-turn-sep">·</i>')
                : ttEsc(L("按用量排序", "by usage"))) + '</div></div>' +
              '<div class="zu-turn-models">' + statModelsTable(sess.models, null, true) + '</div>'
            : "") +
          (d.code && (d.code.add || d.code.del)
            ? '<div class="zu-stat-scale"><span>' + ttEsc(L("代码变更 ", "code ") + "+" + (d.code.add || 0) + " / -" + (d.code.del || 0) +
                (d.code.files ? L("（" + d.code.files + " 文件）", " (" + d.code.files + " files)") : "")) + '</span></div>' : "") +
          '<div class="zu-stat-time">' +
            '<b>' + ttEsc(L("时间范围", "Time span")) + '</b><span>' +
            (sess.started ? fmtStartS(sess.started) : "—") + " — " + (sess.last_at ? fmtStartS(sess.last_at) : "—") + '</span></div>' +
          '</div>');      }
      if (state.show.today) {   // v213 移到会话累计之后（用户规格 2026-11-02，格序：速度→本轮→会话→今日→项目→工具→子代理→⚙）
        /* v301 今日合计紧凑化（同本轮 v299 / 会话 v300 三行 KPI 形态，450 宽×高度自适应）：
         * ①总用量|输入(缓存命中率副行)|输出(含思考) ②请求次数|请求轮数|请求会话
         * ③平均耗时|平均延迟|总耗时 ④平均输出速度(今日加权均 avg_tps 档色)|预估费用；
         * 11 枚 SVG 图标随 KPI 标签（与本轮/会话同表）；
         * 模型表标题行固定+表体独立滚动；时间行钉底。样式经 statCompactStyle("today")
         * 作用域（+today 专属：图标居中/副行绿/单格占满），不波及其它卡。
         * 平均耗时/延迟/速度来自 v301 zusage 今日聚合，旧快照缺字段按 >0 门控收起。 */
        it(ico('<rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M7.5 2.5v4m9-4v4M3 10h18m-13.5 4h2m5 0h2m-9 4h2m5 0h2"/>') +
          '<span class="v">' + fmt(today.total) + "</span>" +
          (state.theme === "pill" ? "" :
            (today.turns != null
              ? '<span class="dim">' + countFmt(today.turns) + L("轮 ", " turns · ") + countFmt(today.requests || 0) + L("次", " req") + "</span>"
              : '<span class="dim">' + countFmt(today.requests || 0) + L("次", " req") + "</span>")),
          "\x01" +
          statCompactStyle("today") +
          '<div class="zu-stat-tip zu-stat-tip--today">' +
          statHead(L("今日合计", "Today"), L("今天所有会话", "All sessions today")) +
          /* 行一：总用量 | 输入（缓存命中率副行，柔和绿）| 输出（含思考副行） */
          '<div class="zu-turn-kpis">' +
            statKpi(kpiIco("total") + L("总用量", "Total tokens"), ttEsc(fmt(today.total || 0)), turnVBkt(fmt(today.total || 0))) +
            statKpi(kpiIco("input") + L("输入", "Input"), ttEsc(fmt(today.input || 0)), turnVBkt(fmt(today.input || 0)),
              (today.input > 0 ? '<span class="hit">' + ttEsc(L("缓存命中率 ", "cache hit ") + Math.round((today.cache_read || 0) / today.input * 100) + "%") + '</span>' : "")) +
            statKpi(kpiIco("output") + L("输出", "Output"), ttEsc(fmt(today.output || 0)), turnVBkt(fmt(today.output || 0)),
              (today.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(today.reasoning)) : "")) +
          '</div>' +
          /* 行二（v302.2 用户规格，同本轮/会话口径）：请求次数（今日累计请求）|
           * 请求轮数（今日累计轮数）| 请求会话（今日发起过请求的去重会话数，
           * v302.2 zusage 新聚合；0=今日尚无会话请求，非伪造） */
          '<div class="zu-turn-kpis">' +
            statKpi(kpiIco("requests") + L("请求次数", "Requests"), ttEsc(countFmt(today.requests || 0)), turnVBkt(countFmt(today.requests || 0))) +
            /* 轮数/会话数：旧远端快照可能缺字段——缺显「—」不伪造 0（条面 913 行同款
             * != null 门控；本地新快照恒有值，0=今日尚无，照实显示） */
            statKpi(kpiIco("turns") + L("请求轮数", "Turns"), ttEsc(today.turns != null ? countFmt(today.turns) : "—"), turnVBkt(today.turns != null ? countFmt(today.turns) : "")) +
            statKpi(kpiIco("sessions") + L("请求会话", "Sessions"), ttEsc(today.sessions != null ? countFmt(today.sessions) : "—"), turnVBkt(today.sessions != null ? countFmt(today.sessions) : "")) +
          '</div>' +
          /* 行三：平均耗时 | 平均延迟（>0 门控缺失不伪造 0s）| 总耗时（Σ生成耗时，
           * secLong 换算；v302.2 重试格按新规格移除） */
          ((today.avg_duration_ms > 0 || today.avg_ttft_ms > 0 || today.duration_ms > 0)
            ? '<div class="zu-turn-kpis zu-turn-kpis--mid">' +
              (today.avg_duration_ms > 0 ? statKpi(kpiIco("duration") + L("平均耗时", "Avg time"), ttEsc(sec(today.avg_duration_ms)), turnVBkt(sec(today.avg_duration_ms))) : "") +
              (today.avg_ttft_ms > 0 ? statKpi(kpiIco("latency") + L("平均延迟", "Avg TTFT"), ttEsc(sec(today.avg_ttft_ms)), turnVBkt(sec(today.avg_ttft_ms))) : "") +
              (today.duration_ms > 0 ? statKpi(kpiIco("elapsed") + L("总耗时", "Total time"), ttEsc(secLong(today.duration_ms)), turnVBkt(secLong(today.duration_ms))) : "") +
              '</div>' : "") +
          /* 行四（v302.2 改名「平均输出速度」统一三卡措辞）：今日加权均
           * （TPS_BANDS 档色文字）| 预估费用（问号图标沿用）；
           * 费用关/缺失时速度格 only-child 占满整行（today 专属规则） */
          '<div class="zu-turn-kpis zu-turn-kpis--duo">' +
            ((typeof today.avg_tps === "number" && isFinite(today.avg_tps) && today.avg_tps > 0)
              ? statKpi(kpiIco("speed") + L("平均输出速度", "Avg output rate"), '<b class="' + tpsBand(today.avg_tps).cls + '">' + ttEsc(today.avg_tps.toFixed(1)) + '</b> <small>t/s</small>')
              : statKpi(kpiIco("speed") + L("平均输出速度", "Avg output rate"), "—")) +
            ((state.cost && typeof today.cost_usd === "number" && isFinite(today.cost_usd))
              ? statKpi(kpiIco("cost") + L("预估费用", "Est. cost") + fxqIcon(today.models, L("今日", "today")), ttEsc(fmtMoney(today.cost_usd)))
              : "") +
          '</div>' +
          /* 模型明细：标题行固定、表体进独立滚动区（同本轮/会话），多模型区内滚不撑高主卡 */
          /* 模型明细标题行右侧（v302.3 用户规格，同本轮/会话形态）：工具调用/重试并入，
           * 均无时回退「按用量排序」；旧快照缺 tool_calls 只显重试段 */
          ((today.models && today.models.length)
            ? '<div class="zu-pj-mhead"><div class="zu-pj-mtitle">' + ttEsc(L("模型明细", "Models")) + '</div><div class="zu-pj-morder">' +
              ((today.tool_calls || today.retries)
                ? [(today.tool_calls ? ttEsc(L("工具调用 ", "tools ") + countFmt(today.tool_calls) + L(" 次", " calls")) : ""),
                   (today.retries ? ttEsc(L("重试 ", "retries ") + countFmt(today.retries) + L(" 次", " times")) : "")].filter(Boolean).join('<i class="zu-turn-sep">·</i>')
                : ttEsc(L("按用量排序", "by usage"))) + '</div></div>' +
              '<div class="zu-turn-models">' + statModelsTable(today.models, null, true) + '</div>'
            : "") +
          '<div class="zu-stat-time">' +
            '<b>' + ttEsc(L("时间范围", "Time span")) + '</b><span>' +
            (today.started ? fmtStartS(today.started) : "—") + " — " + (today.last_at ? fmtStartS(today.last_at) : "—") + '</span></div>' +
          '</div>');      }
      if (state.show.proj && sess.project) {   // v159 项目累计：本项目全部会话（含子代理），远端/不在本地库无此字段不渲染
        var pj = sess.project;
        var pjKey = (pickedSid || "") + ":" + (pj.started || 0);   // v214 项目卡归属键：项目变化（started 变）自动重置展开态
        if (pjKey !== projTipKey) { projTipKey = pjKey; projTipExpanded = false; }
        it(ico('<path d="M3.5 6.5a2 2 0 0 1 2-2h4.2l2 2h7.3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>') +
          '<span class="v">' + fmt(pj.total) + "</span>" +
          (state.theme === "pill" ? "" :
            (shrink ? "" : "") +
            '<span class="dim">' + countFmt(pj.sessions || 0) + L("会话 ", " sessions · ") + countFmt(pj.requests || 0) + L("次", " req") + "</span>"),
"\x01" + buildProjectTipHTML(pj, pjKey), "zu-pj-item");
      }
      if (state.show.tools) {
        /* v304 工具调用紧凑化（用户 /goal，同四卡家族形态，450 宽×高度自适应）：
         * 标题前置扳手 SVG（statHead 第 4 参）；双 KPI 走 zu-turn-kpis--duo；
         * 四列表格 table-layout:fixed + 长名省略（title 全文）+ sticky 表头；
         * 累计耗时 secLong 换算（title 保留完整秒数）；表体进独立滚动区，
         * 多工具区内滚不撑高主卡；错误 >0 柔和红、0 弱化灰（err/dim0 既有语义）。 */
        var hasTools = tls.list && tls.list.length;
        it(ico('<path d="M14.5 2.5a6 6 0 0 0-5.6 8.1L3.3 16.2a3.2 3.2 0 0 0 4.5 4.5l5.6-5.6a6 6 0 0 0 8.1-5.6l-4.1 3-3.8-3.8 3-4.1a6 6 0 0 0-2.1-2.1z"/>') +
          '<span class="v">' + countFmt(tls.total || 0) + "</span>" +
          (tls.errors ? '<span class="eb">' +
            ico('<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>') +
            tls.errors + "</span>" : ""),
          "\x01" +
          statCompactStyle("tools") +
          '<div class="zu-stat-tip zu-stat-tip--tools">' +
          statHead(L("工具调用", "Tool calls"), "", "", kpiIco("tools")) +
          '<div class="zu-turn-kpis zu-turn-kpis--duo">' +
            statKpi(kpiIco("requests") + L("调用总数", "Total calls"), ttEsc(countFmt(tls.total || 0)) + ' <small>' + ttEsc(L("次", "calls")) + '</small>', turnVBkt(countFmt(tls.total || 0))) +
            statKpi(kpiIco("retry") + L("错误", "Errors"), ttEsc(countFmt(tls.errors || 0)) + ' <small>' + ttEsc(L("次", "times")) + '</small>', (tls.errors ? "err" : "")) +
          '</div>' +
          (hasTools
            ? '<div class="zu-turn-models">' +
              statTable([L("工具", "Tool"), L("调用次数", "Calls"), L("累计耗时", "Total time"), L("错误", "Errors")],
                (tls.list || []).map(function (t1) {
                  var errCell = t1.errors ? '<td class="err">' + ttEsc(countFmt(t1.errors)) + '</td>' : '<td class="dim0">0</td>';
                  var durTxt = !t1.duration_ms ? '0.0s' : (t1.duration_ms < 50 ? '&lt;0.1s' : ttEsc(secLong(t1.duration_ms)));
                  var durCls = (!t1.duration_ms || t1.duration_ms < 50) ? ' class="dim0"' : '';
                  var durTitle = (!t1.duration_ms || t1.duration_ms < 50) ? '' : ' title="' + escAttr(sec(t1.duration_ms)) + '"';
                  return '<tr><td class="zu-pj-mname" title="' + escAttr(t1.name) + '">' + ttEsc(t1.name) + '</td>' +
                    '<td>' + ttEsc(countFmt(t1.count || 0)) + '</td>' +
                    '<td' + durCls + durTitle + '>' + durTxt + '</td>' + errCell + '</tr>';
                }).join("")) + '</div>'
            : '<div class="zu-stat-note">' + ttEsc(L("无工具调用记录", "No tool calls recorded")) + '</div>') +
          '</div>');      }
      if (state.show.sub) {
        /* v93：随「上下文容量」格移除改为始终展示（零值也显示，口径与其他格统一）。
         * v217：悬停/点击都开统一浮层（.zu-sub-pop），__tip 置空不再走通用 tooltip
         * ——旧五段卡与「查看子代理明细」CTA 移除，明细能力由统一浮层右侧承接。 */
        var sb = d.sub || { requests: 0, total: 0, input: 0, output: 0, cache_read: 0, active: false };
        it(ico('<circle cx="5" cy="5" r="3"/><circle cx="19" cy="8" r="3"/><circle cx="5" cy="19" r="3"/><path d="M5 8v8m0-4h9a5 5 0 0 0 5-1"/>') +
          '<span class="v">' + fmt(sb.total) + "</span>" +
(sb.active ? '<span class="ok dot">●</span>' : ""),
          null, "zu-sub");
      }

      return { s: items.join('<span class="sep"></span>') || '<span class="dim">' + L("全部显示项已关闭", "All display items are off") + '</span>', tips: tips };
    }

    /* 当前会话识别（v34 起 mine 优先，此处为兜底启发式）：ZCode 在 localStorage 的
     * "zcode-v4-last-session:v1:<工作区路径>" 键里保存每个工作区当前打开的会话 id。
     * 键随会话切换由应用更新（新开空会话时应用还会删键）；但 localStorage 全窗口共享、
     * 键对"自动新建的会话"更新滞后，多窗口下根本分不清哪个键属于本窗口 ——
     * 所以 v34 起正常路径是泵按窗口注入的 mine（渲染端经 IPC 上报的焦点会话），
     * 只有泵无该窗口信息时（辅助窗口/旧泵）才落到这里：取所有键值与 payload.recent
     * 的 sid 求交集；多候选取最近活跃（数值 last_at 比较，勿用 HH:MM:SS 字符串，跨午夜会排错）。
     * v32：键值即使不在 recent 池里也作为 want 返回（挂 window.__zusageWantSid），
     * 泵把它传给 zusage.py 强制纳入快照——刚开的新会话/超出 6+6 池的会话也能显示自己的数据。
     * 注意：会话标题不在可扫描的 DOM 文本节点里（顶栏标题扫描方案实测永远失败，勿回退）。 */
    var pickedSid = "", wsPrev = null, lastHtml = "";
    function watchQuotaSelection(pane) {
      if (pane === quotaPaneRoot) return;
      if (quotaSelectionObserver) quotaSelectionObserver.disconnect();
      quotaSelectionObserver = null;
      quotaPaneRoot = pane;
      if (!pane) return;
      quotaSelectionObserver = new MutationObserver(function () {
        if (inactive()) return;
        if (readQuotaSelection() && state.data) render(state.data);
      });
      quotaSelectionObserver.observe(pane, { subtree: true, childList: true, attributes: true,
        attributeFilter: ["data-provider", "data-model", "data-session-id"] });
    }
    function readQuotaSelection() {
      var el = wantedEl || composer, pane = null, selection = null;
      var sid = instSid || pickedSid || "";
      if (el && el.isConnected) {
        for (var parent = el; parent && parent !== document.body; parent = parent.parentElement) {
          var tid = parent.getAttribute && parent.getAttribute("data-testid");
          if (tid && tid.indexOf("v4-session-pane-") === 0) { pane = parent; break; }
        }
      }
      watchQuotaSelection(pane);
      if (pane) {
        selection = { sid: sid, providerId: "", modelId: "" };
        var paneSid = pane.getAttribute("data-session-id");
        var paneId = pane.getAttribute("data-testid").slice("v4-session-pane-".length);
        if (paneSid === sid && (pid === "auto" || paneId === pid)) {
          var nodes = pane.querySelectorAll('[data-testid="v4-model-config"]');
          var own = [];
          for (var i = 0; i < nodes.length; i++) {
            var owner = nodes[i].parentElement;
            while (owner && owner !== pane) {
              var ot = owner.getAttribute && owner.getAttribute("data-testid");
              if (ot && ot.indexOf("v4-session-pane-") === 0) break;
              owner = owner.parentElement;
            }
            if (owner === pane) own.push(nodes[i]);
          }
          if (own.length) quotaMarkerSeen = true;
          if (!own.length && !quotaMarkerSeen) selection = null;
          if (own.length === 1) {
            var provider = own[0].getAttribute("data-provider");
            var model = own[0].getAttribute("data-model");
            if (typeof provider === "string" && provider.length <= 160 &&
                typeof model === "string" && model.length <= 160 && !/[\x00-\x1f\x7f]/.test(provider + model)) {
              selection.providerId = provider.trim();
              selection.modelId = model.trim();
            }
          }
        }
      } else if (quotaSelection) {
        selection = { sid: sid, providerId: "", modelId: "" };
      }
      if (JSON.stringify(selection) === JSON.stringify(quotaSelection)) return false;
      quotaSelection = selection;
      if (instances.length) reportQuotaSelections();
      return true;
    }
    function effectiveQuotaProvider() {
      return quotaSelection ? quotaSelection.providerId : (quotaProvider || quotaFallback);
    }
    function pickCurrent(d) {
      var recent = d.recent || [];
      if (!recent.length) return null;
      var bySid = {}, kv = {};
      for (var i = 0; i < recent.length; i++) bySid[recent[i].sid] = recent[i];
      try {
        Object.keys(localStorage).forEach(function (k) {
          if (/^zcode-v4-last-session:/.test(k)) {
            var v = localStorage.getItem(k);
            if (v && /^[A-Za-z0-9_-]+$/.test(v)) kv[k] = v;
          }
        });
      } catch (e) { return null; }
      if (!Object.keys(kv).length) return null;
      var hit = {}, firstKeyVal = "";
      for (var k in kv) {
        if (bySid[kv[k]]) hit[k] = kv[k];
        if (!firstKeyVal) firstKeyVal = kv[k];
      }
      var switched = null;
      if (wsPrev) {
        for (var k2 in kv) {
          if (wsPrev[k2] && wsPrev[k2] !== kv[k2]) switched = kv[k2];   // 该工作区刚切换了会话
        }
      }
      wsPrev = kv;
      /* want = 当前真正打开的会话（切换优先，否则任一键值），交由泵强制补拉 */
      var want = switched || firstKeyVal;
      if (switched && bySid[switched]) return { sess: bySid[switched], want: want };
      var cands = [];
      for (var k3 in hit) cands.push(bySid[hit[k3]]);
      if (cands.length === 1) return { sess: cands[0], want: want };
      if (!cands.length) return { sess: null, want: want };
      var best = cands[0];   // 多候选：取最近活跃的
      for (var n = 1; n < cands.length; n++) {
        if ((cands[n].last_at || 0) > (best.last_at || 0)) best = cands[n];
      }
      return { sess: best, want: want };
    }

    /* 子代理查看视图识别：子代理会话的任务提示词会作为聊天气泡文本出现在消息流里，
     * 用 recent 中 is_sub 候选的标题前缀（前 30 字）在 DOM 文本里匹配。
     * （主会话的标题不在 DOM 文本里，但子代理视图的气泡是普通文本，可匹配。） */
    /* 零值会话 stub：当前会话在共享池里还没有数据行（新会话没发过消息/还没拉到）时，
     * 显示"当前会话的 0 值"。绝不回退到池里别的会话 —— 显示错会话的数字正是 v34 修的 bug。 */
    function stubFor(sid) {
      return { sid: String(sid || ""), title: "", active: false, turns: 0, requests: 0,
        input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0,
        tool_calls: 0, retries: 0, ctx: 0, updated: "", last_at: 0, ctx_exc: 0, started: 0,
        last_turn: {requests: 0, retries: 0, tool_calls: 0, tool_errors: 0, input: 0, output: 0,
          reasoning: 0, cache_read: 0, cache_write: 0, total: 0, duration_ms: 0, ttft_ms: 0, started: 0, ended: 0},
        last: {duration_ms: 0, ttft_ms: 0, model: "", tps: 0, startedAt: 0, endedAt: 0},
        code: {add: null, del: null, files: null},
        tools: {total: 0, errors: 0, list: []},
        sub: {requests: 0, total: 0, input: 0, output: 0, cache_read: 0, reasoning: 0,
          cache_write: 0, active: false, list: []},
        context_window: 0, context_auto: false };
    }

