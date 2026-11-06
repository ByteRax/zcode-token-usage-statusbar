    /* ---------- 子代理统一浮层（v217）：悬停预览/点击固定，双栏单一组件 ----------
     * 旧两层界面（悬停五段卡 tooltip + 点击弹出的独立明细面板）合并：同一入口、
     * 同一浮层、closed/preview/pinned 三态一套控制。外壳（标题栏/导航/底栏）与右栏
     * 内容按签名幂等重建，重建前后恢复左右滚动位置；选中任务按 sid 维护，任务从
     * 当前会话数据消失才回「汇总」。运行中尚未入库的槽位（subRate.slots）同样进
     * 导航（无记录项显示运行状态与估算速率）。会话切换即关闭，不跨会话沿用选择。 */
    var subPopSel = "";          // 选中任务 sid（""=汇总）
    var subPopMode = "closed";   // closed | preview | pinned
    var subPopEntry = null;      // 触发元素（.zu-sub 条目 / compact chip）
    var subPopHideTimer = 0;     // preview 离开后的延迟关闭
    var subPopSuppressAt = 0;    // 显式关闭后的本次悬停抑制（防立即重开）
    var subPopSig = "";          // 渲染签名（幂等：数据推送/切换不闪烁）
    var subPopSess = "";         // 打开时会话（pickedSid），变化即关
    function subPopOpen() { return subPopMode !== "closed"; }
    function subPopIco(paths, size) {
      /* 浮层挂 body 不在 .zusage-root 内，.ico 宽高样式不生效——显式尺寸 */
      return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    }
    function subPopItems(sub) {
      var list = (sub && sub.list) || [], out = [], seen = {}, i;
      for (i = 0; i < list.length; i++) {
        var s1 = list[i], sid = String(s1.sid || "");
        if (!sid || seen[sid]) continue;
        seen[sid] = 1;
        out.push({ sid: sid, rec: s1 });
      }
      var sids = [];
      for (var k in subRate.slots) sids.push(k);
      sids.sort();
      for (i = 0; i < sids.length; i++) if (!seen[sids[i]]) out.push({ sid: sids[i], rec: null });
      return out;
    }
    function subPopNameOf(it1) {
      if (!it1.rec) return L("子代理 …", "agent …") + it1.sid.slice(-4);
      return String(it1.rec.task || "").trim() || String(it1.rec.title || "").trim() ||
        String(it1.rec.agent || "sub").replace(/^zcode-/, "") + "…" + it1.sid.slice(-4);
    }
    function subPopRunningCount() {
      var n = 0, now = Date.now();
      for (var k in subRate.slots) {
        var sl = subRate.slots[k];
        if (sl && sl.rate != null && now - sl.at <= 3000) n++;
      }
      return n;
    }
    function subPopKpi(k, v, u) {
      return '<div class="zu-sp-kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
        (u ? '<div class="u">' + u + "</div>" : "") + "</div>";
    }
    function subPopKpis(a1, a2, a3, extraCls) {
      return '<div class="zu-sp-kpis3' + (extraCls ? " " + extraCls : "") + '">' + a1 + a2 + a3 + "</div>";
    }
    /* 模型用量四列表（汇总页/任务页共用）：逐模型费用尾随 ? 图标（data-model/data-rates
     * 随行携带单价，面板 fxq 委托弹说明），费开关关/无费用列显 — */
    function subPopModelsHTML(models) {
      if (!models || !models.length) return "";
      var rows = models.map(function (m1) {
        var mc = "—";
        if (state.cost && typeof m1.cost_usd === "number" && isFinite(m1.cost_usd)) {
          mc = ttEsc(fmtMoney(m1.cost_usd)) +
            FXQ_ICON.replace('class="tip-fxq"', 'class="tip-fxq" data-model="' + escAttr(m1.model || "") + '"' +
              (m1.rates ? ' data-rates="' + escAttr(JSON.stringify(m1.rates)) + '"' : ""));
        }
        return "<tr><td>" + ttEsc(m1.model || L("未知模型", "unknown")) + "</td><td>" + ttEsc(fmt(m1.total || 0)) +
          "</td><td>" + ttEsc(countFmt(m1.requests || 0)) + "</td><td>" + mc + "</td></tr>";
      }).join("");
      return '<div class="zu-sp-models"><h4>' + ttEsc(L("模型用量", "Model usage")) + "</h4><table><thead><tr>" +
        "<th>" + ttEsc(L("模型", "Model")) + "</th><th>" + ttEsc(L("Token 用量", "Tokens")) + "</th><th>" +
        ttEsc(L("请求", "Requests")) + "</th><th>" + ttEsc(L("预估费用", "Est. cost")) + "</th></tr></thead><tbody>" +
        rows + "</tbody></table></div>";
    }
    function subPopSummaryHTML(sub) {
      var run = subPopRunningCount();
      var costOk = !!(state.cost && sub && typeof sub.cost_usd === "number" && isFinite(sub.cost_usd));
      var sIn = (sub && sub.input) || 0, sHit = sIn > 0 ? Math.round(((sub && sub.cache_read) || 0) / sIn * 100) : -1;
      var sRea = (sub && sub.reasoning) || 0;
      var k1 = subPopKpi(ttEsc(L("总用量", "Total tokens")), ttEsc(fmt((sub && sub.total) || 0)), "");
      var k2 = subPopKpi(ttEsc(L("请求次数", "Requests")), ttEsc(countFmt((sub && sub.requests) || 0)), "");
      var k3 = subPopKpi(ttEsc(L("预估费用", "Est. cost")) + fxqIcon(sub && sub.models, L("子代理累计", "the sub-agents")), costOk ? ttEsc(fmtMoney(sub.cost_usd)) : "—", "");
      var u1 = subPopKpi(ttEsc(L("输入", "Input")), ttEsc(fmt(sIn)),
        sHit >= 0 ? '<span class="hit">' + ttEsc(L("缓存命中率 ", "cache hit ") + sHit + "%") + '</span>' : "");
      var u2 = subPopKpi(ttEsc(L("输出", "Output")), ttEsc(fmt((sub && sub.output) || 0)),
        sRea > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(sRea)) : "");
      var u3 = subPopKpi(ttEsc(L("缓存命中", "Cache read")), ttEsc(fmt((sub && sub.cache_read) || 0)), "");
      var band = sub && sub.rate_avg > 0 ? tpsBand(sub.rate_avg) : null;
      var rate = '<div class="zu-sp-rate">' + ttEsc(L("平均速率", "Average rate")) +
        (band ? '<b class="' + band.cls + '">' + ttEsc(sub.rate_avg.toFixed(1)) + "</b>" + ttEsc(L(" t/s", " t/s"))
              : "<b>—</b>") + "</div>";
      var models = subPopModelsHTML(sub && sub.models);
      return '<div class="zu-spview-head"><h3>' + ttEsc(L("汇总", "Summary")) + "</h3>" +
        '<span class="zu-spstate' + (run ? " run" : "") + '"><span class="dot"></span>' +
        ttEsc(run ? run + L(" 个子代理运行中", " sub-agent(s) running") : L("暂无运行中的子代理", "No running sub-agents")) +
        "</span></div>" +
        subPopKpis(k1, k2, k3) + subPopKpis(u1, u2, u3, "zu-sp-usage") + rate + models;
    }
    function subPopDetailHTML(it1) {
      var r = it1.rec || {}, name = subPopNameOf(it1);
      var sub2 = String(r.agent || "subagent").replace(/^zcode-/, "") + " · …" + it1.sid.slice(-4);
      var band = r.tps_avg > 0 ? tpsBand(r.tps_avg) : null;
      var rIn = r.input || 0, rHit = rIn > 0 ? Math.round((r.cache_read || 0) / rIn * 100) : -1;
      var k1 = subPopKpi(ttEsc(L("总消耗", "Total")), ttEsc(fmt(r.total || 0)), "");
      var k2 = subPopKpi(ttEsc(L("请求次数", "Requests")), ttEsc(countFmt(r.requests || 0)), "");
      var k3 = subPopKpi(ttEsc(L("平均速率", "Avg rate")),
        band ? '<span class="' + band.cls + '">' + ttEsc(r.tps_avg.toFixed(1)) + '</span><small>t/s</small>' : "—", "");
      var u1 = subPopKpi(ttEsc(L("输入", "Input")), ttEsc(fmt(rIn)),
        rHit >= 0 ? '<span class="hit">' + ttEsc(L("缓存命中率 ", "cache hit ") + rHit + "%") + '</span>' : "");
      var u2 = subPopKpi(ttEsc(L("输出", "Output")), ttEsc(fmt(r.output || 0)),
        r.reasoning > 0 ? ttEsc(L("含思考 ", "incl. ") + fmt(r.reasoning)) : "");
      var u3 = subPopKpi(ttEsc(L("缓存命中", "Cache read")), ttEsc(fmt(r.cache_read || 0)),
        r.cache_write > 0 ? ttEsc(L("缓存写入 ", "cache write ") + fmt(r.cache_write)) : "");
      var meta = [];
      if (r.last) meta.push(L("最后活动", "Last active") + " <b>" + ttEsc(fmtStartS(r.last)) + "</b>");
      if (r.active || it1.rec === null) {
        /* 运行中：估算速率 span 由面板 800ms tick 原地刷新（.subrate[data-sid] 契约不变） */
        meta.push('<span class="subrate" data-sid="' + escAttr(it1.sid) + '">' + ttEsc(subRateSlotText(it1.sid)) + "</span>");
      }
      return '<div class="zu-spview-head"><h3 title="' + escAttr(name) + '">' + ttEsc(name) + "</h3>" +
        '<span class="zu-spsub">' + ttEsc(sub2) + "</span></div>" +
        subPopKpis(k1, k2, k3) + subPopKpis(u1, u2, u3, "zu-sp-usage") +
        subPopModelsHTML(r.models) +
        (meta.length ? '<div class="zu-sp-meta">' + meta.join("") + "</div>" : "");
    }
    function buildSubPop(sub) {
      var items = subPopItems(sub);
      if (subPopSel) {
        var keep = items.filter(function (x) { return x.sid === subPopSel; });
        if (!keep.length) subPopSel = "";   // 任务已从当前会话数据消失才回汇总
      }
      var runN = subPopRunningCount();
      var sig = subPopMode + "|" + subPopSel + "|" + items.map(function (x) { return x.sid; }).join(",") +
        "|" + runN + "|" + (state.cost ? 1 : 0) + "|" + JSON.stringify(sub || null);
      if (sig === subPopSig) return;
      subPopSig = sig;
      var oldNav = subPanel.querySelector(".zu-spnav-list"), oldBody = subPanel.querySelector(".zu-spbody");
      var navTop = oldNav ? oldNav.scrollTop : 0, bodyTop = oldBody ? oldBody.scrollTop : 0;
      var nav = '<button type="button" class="zu-spnav-item' + (subPopSel === "" ? " on" : "") + '" data-sid="" aria-selected="' + (subPopSel === "") + '"><span class="zu-spnav-label">' + ttEsc(L("汇总", "Summary")) + "</span></button>" +
        '<div class="zu-spnav-h">' + ttEsc(L("任务列表", "Tasks")) + '</div><div class="zu-spnav-list">';
      for (var i = 0; i < items.length; i++) {
        var on = items[i].sid === subPopSel;
        nav += '<button type="button" class="zu-spnav-item' + (on ? " on" : "") + '" data-sid="' + escAttr(items[i].sid) +
          '" aria-selected="' + on + '" title="' + escAttr(subPopNameOf(items[i])) + '"><span class="zu-spnav-label">' +
          ttEsc(subPopNameOf(items[i])) + "</span>" +
          (items[i].rec === null ? '<span class="zu-spnav-live" data-sid="' + escAttr(items[i].sid) + '">' + ttEsc(subRateSlotText(items[i].sid)) + "</span>" : "") +
          "</button>";
      }
      nav += "</div>";
      var body = subPopSel === "" ? subPopSummaryHTML(sub)
        : subPopDetailHTML(items.filter(function (x) { return x.sid === subPopSel; })[0]);
      subPanel.innerHTML =
        '<div class="zu-sph">' + subPopIco('<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="7.5" r="2.6"/><circle cx="8" cy="18" r="2.6"/><path d="M7.5 8.2 8 15.4M16.2 9.2 9.8 16.2M8.6 6.2l7 1"/>', 20) +
          '<span class="zu-sph-t">' + ttEsc(L("子代理", "Sub-agents")) + "</span>" +
          '<span class="zu-sph-scope">' + ttEsc(L("当前会话", "Current session")) + "</span>" +
          '<button type="button" class="zu-sph-x" aria-label="' + ttEsc(L("关闭", "Close")) + '">' +
            subPopIco('<path d="M18 6 6 18M6 6l12 12"/>', 15) + "</button></div>" +
        '<div class="zu-spb"><nav class="zu-spnav" aria-label="' + ttEsc(L("任务导航", "Task navigation")) + '">' + nav + "</nav>" +
          '<section class="zu-spbody">' + body + "</section></div>" +
        '<div class="zu-spf">' + subPopIco('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>', 14) +
          ttEsc(L("独立统计，不计入会话累计。", "Tracked separately, not counted in session total.")) + "</div>";
      var nN = subPanel.querySelector(".zu-spnav-list"), bN = subPanel.querySelector(".zu-spbody");
      if (nN) nN.scrollTop = navTop;   // 数据刷新保持左列表滚动位置
      if (bN) bN.scrollTop = bodyTop;
    }
    function positionSubPop() {
      if (!subPopOpen()) return;
      if (subPopEntry && !subPopEntry.isConnected) { subPopClose(false, "entry-gone"); return; }
      var width = subPanel.offsetWidth, height = subPanel.offsetHeight;
      var ir = subPopEntry ? subPopEntry.getBoundingClientRect() : bar.getBoundingClientRect();
      if (!ir.width && !ir.height) ir = bar.getBoundingClientRect();   // 隐藏条内入口 rect 全零，回退条锚
      var left = ir.left + ir.width / 2 - width / 2;
      left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
      var top = ir.top - height - 12;   // 优先入口上方，12px 安全缝
      if (top < 12) {
        top = ir.top + ir.height + 12;   // 上方不足翻下方
        if (top + height > window.innerHeight - 12) top = Math.max(12, window.innerHeight - height - 12);
      }
      subPanel.style.left = Math.round(left) + "px";
      subPanel.style.top = Math.round(top) + "px";
    }
    var subRateTimer = 0;
    function subRateTickPanel() {
      if (inactive() || !subPopOpen()) {
        if (subRateTimer) { clearInterval(subRateTimer); subRateTimer = 0; }
        return;
      }
      var spans = subPanel.querySelectorAll(".subrate");
      for (var i = 0; i < spans.length; i++) {
        var txt = subRateSlotText(spans[i].getAttribute("data-sid") || "");
        if (spans[i].textContent !== txt) spans[i].textContent = txt;
      }
    }
    /* 数据推送跟随（render 两路径共用）：会话切换即关（不跨会话沿用选择/数据）；
     * 默认模式条面重建后按同 pane 唯一 .zu-sub 重绑入口，随后签名幂等刷新内容 */
    function subPopFollowPush(view) {
      if (!subPopOpen()) return;
      if (pickedSid !== subPopSess) { subPopClose(false, "session-switch"); return; }
      if (subPopEntry && !subPopEntry.isConnected && state.theme !== "compact") {
        var nuE = main.querySelector(".zu-sub");
        if (nuE) subPopEntry = nuE;
      }
      buildSubPop(view.sub);
    }
    function subPopCancelHide() { if (subPopHideTimer) { clearTimeout(subPopHideTimer); subPopHideTimer = 0; } }
    function subPopScheduleHide() {
      if (subPopMode !== "preview" || subPopHideTimer) return;
      subPopHideTimer = setTimeout(function () { subPopHideTimer = 0; subPopClose(false, "preview-leave"); }, 260);
    }
    function subPopShow(entry, pinned) {
      if (inactive()) return;
      subPopCancelHide();
      subPopEntry = entry || subPopEntry;
      var wasClosed = subPopMode === "closed";
      if (wasClosed) { subPopSel = ""; subPopSess = pickedSid; }   // 每次新开默认汇总
      subPopMode = pinned ? "pinned" : (wasClosed ? "preview" : subPopMode);
      closeSettings(false);   // 与设置面板互斥
      hideTip(true, "sub-pop");   // 移向入口的路上可能触发过条目 tooltip
      subPanel.classList.toggle("zu-light", !themeDark);   // 主题即时同步（applyBarTheme 只在切换路径跑）
      subPanel.classList.add("open");
      buildSubPop(lastSub);
      positionSubPop();
      if (!subRateTimer) subRateTimer = setInterval(subRateTickPanel, 800);
      if (pinned) {
        var first = subPanel.querySelector('.zu-spnav-item[data-sid=""]');
        if (first && first.focus) first.focus();   // 键盘/点击固定：焦点进「汇总」导航项
      }
    }
    function subPopClose(restoreFocus, cause) {
      var trg = null;
      if (restoreFocus) {
        trg = state.theme === "compact" ? (tpsChipCache && tpsChipCache.isConnected ? tpsChipCache : null)
          : main.querySelector(".zu-sub");
      }
      if (subPopHideTimer) { clearTimeout(subPopHideTimer); subPopHideTimer = 0; }
      subPopMode = "closed";
      subPopEntry = null;
      subPopSel = "";
      subPopSig = "";
      subPanel.classList.remove("open");
      if (subRateTimer) { clearInterval(subRateTimer); subRateTimer = 0; }
      if (trg && trg.focus) trg.focus();   // Escape/关闭按钮：焦点归还实际入口（compact 归 chip）
      subPopSuppressAt = Date.now() + 500;   // 关闭后短暂抑制悬停重开（鼠标仍停留入口时不闪回）
    }
    subPanel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); subPopClose(true, "escape"); }
    });
    subPanel.addEventListener("focusin", function () {
      if (subPopMode === "preview") subPopMode = "pinned";   // 键盘 Tab 进浮层即固定（预览不抢焦点）
    });
    bar.addEventListener("click", function (e) {
      if (inactive()) return;
      if (e.target && e.target.closest && e.target.closest(".zu-sub")) {
        e.stopPropagation();
        /* 悬停后的第一次点击是固定当前浮层，不当成关闭；pinned 再点入口才关 */
        if (subPopMode === "pinned") subPopClose(true, "re-click");
        else subPopShow(e.target.closest(".zu-sub"), true);
        return;
      }
      /* v249 点击激活：只在开关开启时接管普通格子；关闭（缺省）沿用 mousemove 即时链。
       * 点开的 tooltip 复用既有「移入 tip 保持 / 移出条面收起 / Escape 收」逻辑，
       * 不另起 pin 状态机（键盘 focusin 仍即时打开，两种模式一致）。 */
      if (state.tipClick && e.target && e.target.closest) {
        var ci = e.target.closest(".it");
        if (ci && ci.__tip) {
          e.stopPropagation();
          mouseInBar = true;
          /* 鼠标点 span[tabindex=0] 会先 focusin 即时打开（键盘无障碍要求），click 紧随其后；
           * 此刻不可按「再点关闭」处理，否则首击点不开。仅 focusin 之外的再点才关闭。 */
          if (ci !== tipFor) showTipFor(ci);
          else if (Date.now() - focusTipAt > 300) hideTip(true, "re-click");
        }
      }
    });
    subPanel.addEventListener("click", function (e) {
      if (inactive()) return;
      if (e.target && e.target.closest && e.target.closest(".zu-sph-x")) {
        e.stopPropagation();
        subPopClose(true, "close-btn");
        return;
      }
      if (subPopMode === "preview") subPopMode = "pinned";   // 面板内任意点击即固定
      var b = e.target && e.target.closest ? e.target.closest(".zu-spnav-item") : null;
      if (!b) return;
      var next = b.getAttribute("data-sid") || "";
      if (next !== subPopSel) { subPopSel = next; buildSubPop(lastSub); }   // 原位切右栏，外壳不动
    });

    /* ---------- 输入框查找（穿透 open shadow / 同源 iframe） ---------- */
    var COMPOSER_SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
    var deepCache = { el: null, at: 0 };
    function visible(el) {
      var r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < innerHeight;
    }
    function deepFind() {
      if (deepCache.el && deepCache.el.isConnected && reallyVisible(deepCache.el)) return deepCache.el;
      if (Date.now() - deepCache.at < 1000) return null;
      deepCache.at = Date.now();
      var found = null;
      function scan(doc, depth) {
        if (found || !doc || depth > 8) return;
        try {
          doc.querySelectorAll(COMPOSER_SEL).forEach(function (el) {
            if (el.closest && el.closest('[role="dialog"]')) return;   // v62：弹窗内的编辑框不是聊天输入框（issue #9）
            if (inSettingsView(el)) return;   // 设置页（MCP 配置等）的编辑框不是聊天输入框
            if (!found && visible(el) && el.getBoundingClientRect().top > innerHeight * 0.45) found = el;
            else if (found && el.getBoundingClientRect().top > found.getBoundingClientRect().top && visible(el)) found = el;
          });
        } catch (e) { }
        if (found) return;
        try {
          doc.querySelectorAll("*").forEach(function (el) {
            if (!found && el.shadowRoot) scan(el.shadowRoot, depth + 1);
          });
        } catch (e) { }
        try {
          doc.querySelectorAll("iframe").forEach(function (fr) {
            if (!found) { try { if (fr.contentDocument) scan(fr.contentDocument, depth + 1); } catch (e) { } }
          });
        } catch (e) { }
      }
      scan(document, 0);
      if (found) deepCache.el = found;
      return found;
    }
    /* 输入框是否真的露在屏幕上：幽灵子树检测（设置页等 opacity-0/inert 壳，v61）+
     * 中心点命中测试（真渲染出来的覆盖层，如全屏对话框背景、悬浮菜单）。 */
    /* 自己的浮层（设置面板/超限气泡/悬停 tooltip）展开在条上方、必然覆盖输入区中心：
     * 若算进遮挡判定，会进 隐藏→复显→再隐藏 的循环（v40 离线复现的"打开设置闪烁"根因；
     * v41 补 tooltip——会话/工具的长 tooltip 同样盖住输入框中心，悬停 0.4s 后闪一下且 tooltip 消失）。
     * 只豁免 track 的可见性路径；findComposer 找输入框时不用（ownOK 缺省 false）。 */
    function isOwnOverlay(el) {
      try { return !!(el && el.closest && el.closest(".zusage-tip-root,.panel,.zusage-exc")); } catch (e) { return false; }
    }
    /* 幽灵子树检测（v61，取代 v58/v59 的 coverLock + 穿透特判）：
     * 客户端 3.11.x 的设置页 = 设置 tab 激活时给工作区主视图套 opacity-0 + inert +
     * pointer-events-none 的壳（DOM 与几何原样保留，纯视觉隐藏）。输入框落在这类
     * "保持挂载但视觉已隐藏"的祖先链里就判不可见 —— 直接读计算样式，与
     * elementFromPoint 无关，天然免疫滚动锁定期的穿透假象。 */
    function inGhostSubtree(el) {
      try {
        for (var p = el; p && p !== document.body; p = p.parentElement) {
          if (p.inert) return true;
          var cs = getComputedStyle(p);
          if (cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return true;
        }
      } catch (e) { }
      return false;
    }
    /* 判定缓存（v115）：track 每帧沿输入框祖先链逐个 getComputedStyle（幽灵判定），模态
     * 判定逐帧 querySelector + 遍历 body 子层，命中测试逐帧 elementFromPoint——60fps 下
     * 稳定产生每秒数十次强制样式查询，是悬浮条常驻 CPU 的最大来源。幽灵/遮挡/模态只随
     * 布局与弹层开关变化，条本身有 400ms 隐藏迟滞兜底，120~150ms 的判定陈旧肉眼不可感；
     * 用纯 TTL 缓存而不是 MutationObserver 脏标——流式输出每帧都在改 DOM，脏标会被
     * 反复置位而失效。命中结果绑定「元素矩形 + 模式」：矩形一变立即重算。 */
    var GHOST_TTL = 120, COVER_TTL = 150;
    var ghostCache = new WeakMap();   // el -> { val, at }
    var coverCache = new WeakMap();   // el -> { key, rect, val, at }（reallyVisible/coverOK 共用，key 区分模式）
    function ghostOf(el) {
      if (!el) return false;
      var now = Date.now(), hit = ghostCache.get(el);
      if (hit && now - hit.at < GHOST_TTL) return hit.val;
      var val = inGhostSubtree(el);
      ghostCache.set(el, { val: val, at: now });
      return val;
    }
    /* 模态弹窗打开判定（v62，issue #9）：Radix Dialog 往 body 挂一层「固定全屏 + 带底色 +
     * z-index 抬升」的遮罩（下拉菜单/选择器只设 body pointer-events:none、不挂遮罩——v61
     * 实测），且文档里同时存在 [role="dialog"]。此时聊天区整体不可交互，条必须整体收起：
     * 模型配置弹窗里的「推理参数映射」编辑框正好落在视口下半部，会被 findComposer 的
     * 启发式当聊天输入框，条就冒在弹窗里（用户 issue #9 截图）。
     * 自己的浮层（.zu-bar/.zu-back/.zu-sheet——移动端抽屉遮罩是同款全屏底色）不算。 */
    function modalOpen() {
      try {
        var dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"]');
        var hasVisibleDialog = false;
        for (var d = 0; d < dialogs.length; d++) {
          if (dialogs[d].classList && dialogs[d].classList.contains("zusage-panel")) continue;
          var ds = getComputedStyle(dialogs[d]);
          if (ds.display !== "none" && ds.visibility !== "hidden" && parseFloat(ds.opacity || "1") >= 0.05) {
            hasVisibleDialog = true;
            break;
          }
        }
        if (!hasVisibleDialog) return false;
        var kids = document.body.children;
        for (var i = 0; i < kids.length; i++) {
          var el = kids[i];
          var cls = String(el.getAttribute && el.getAttribute("class") || "");
          if (el.id === "zusage-bar" || /(^|\s)zu-(bar|back|sheet)(\s|$)/.test(cls) || (el.classList && el.classList.contains("zusage-panel"))) continue;
          var cs = getComputedStyle(el);
          if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
          if (parseFloat(cs.opacity || "1") < 0.05) continue;
          if (!(parseInt(cs.zIndex, 10) >= 10)) continue;   // 遮罩必抬层（z-40/50）；普通全屏容器不抬
          var r = el.getBoundingClientRect();
          if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) continue;
          var bg = cs.backgroundColor;
          if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") continue;
          return true;
        }
      } catch (e) { }
      return false;
    }
    /* v115：modalOpen 每次调用先 querySelector、有弹窗时再逐 body 子层 getComputedStyle；
     * track 逐帧调用是纯浪费。弹层开关远慢于 150ms，TTL 缓存后逐帧零开销。
     * diagHidden 用原版 modalOpen（诊断要现场真值，不吃缓存）。 */
    var MODAL_TTL = 150, modalAt = 0, modalVal = false;
    function modalOpenCached() {
      var now = Date.now();
      if (now - modalAt < MODAL_TTL) return modalVal;
      modalAt = now;
      modalVal = modalOpen();
      return modalVal;
    }
    function reallyVisible(el, ownOK) {
      if (!visible(el)) return false;
      if (ghostOf(el)) return false;   // 设置页等幽灵壳：视觉已隐藏（v61，v115 TTL 缓存）
      var r = el.getBoundingClientRect();
      var key = ownOK ? "o" : "n";
      var rectKey = r.left + "," + r.top + "," + r.width + "," + r.height;
      var now = Date.now(), ch = coverCache.get(el);
      if (ch && ch.key === key && ch.rect === rectKey && now - ch.at < COVER_TTL) return ch.val;
      var val = hitSelf(el, r, ownOK);
      coverCache.set(el, { key: key, rect: rectKey, val: val, at: now });
      return val;
    }
    function hitSelf(el, r, ownOK) {
      var hit;
      try { hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) { return true; }
      if (!hit) return false;
      /* 命中根元素 = 穿透（v61 翻转判定）：Radix 模态层（下拉/对话框/modal 弹层）打开时给
       * body 设 pointer-events:none，应用树全被跳过、elementFromPoint 一路穿到 <html>。
       * v58/v59 曾把它当"被盖"（修设置页冒条），但正常聊天里开任何下拉也会中招——
       * 条被误藏（用户实测）。现改判"可见"：设置页场景由 inGhostSubtree 兜住
       * （3.11.x 设置壳必带 opacity-0+inert，不依赖命中测试），其余穿透场景
       * 都是真·未被盖（弹层在别处，输入框露着）。 */
      if (hit === document.body || hit === document.documentElement) return true;
      if (hit === el || hit.contains(el) || el.contains(hit)) return true;   // 命中自身/祖先/内部装饰层
      /* 悬浮气泡豁免（v65）：非模态浮层（「剩余额度」hover 卡、下拉/选择器弹层——body
       * 直挂、无遮罩）会压住输入框中心点，按旧判定悬停一超 400ms 迟滞整条就消失
       * （用户实测）。但条挂在输入框正下方，上方浮层与条并无几何冲突：命中元素只是
       * 部分遮挡（未把输入框矩形整体罩住）时仍判可见。整体罩住才维持"被盖"——模态
       * 全屏遮罩等真接管行为不变，模态弹窗/设置页另有 modalOpen/inGhostSubtree 收口。 */
      var hr = hit.getBoundingClientRect();
      if (hr.left > r.left || hr.top > r.top || hr.right < r.right || hr.bottom < r.bottom) return true;
      if (ownOK && isOwnOverlay(hit)) return true;
      return false;
    }
    function findComposer() {
      var best = null;
      document.querySelectorAll("textarea").forEach(function (ta) {
        if (ta.closest && ta.closest('[role="dialog"]')) return;   // v62：弹窗内的编辑框不是聊天输入框（模型配置弹窗的「推理参数映射」落在下半屏，issue #9）
        if (inSettingsView(ta)) return;   // 设置页（MCP 配置等）的编辑框不是聊天输入框
        if (!reallyVisible(ta)) return;
        var r = ta.getBoundingClientRect();
        if (r.top < innerHeight * 0.45) return;   // 聊天输入框特征：在视口下半部（排除设置页等处元素）
        if (!best || r.top > best.getBoundingClientRect().top) best = ta;
      });
      return best || deepFind();
    }
    function collectDiag(extra) {
      if (everMounted) return;  /* 已成功挂载的窗口才允许写诊断，防后台空窗口覆盖 */
      if (Date.now() - (collectDiag.at || 0) < 5000) { if (extra) Object.assign(window.__zusageDiag, extra); return; }
      collectDiag.at = Date.now();
      /* 只在 window.__zusageDiag 本体上原地更新，绝不整体替换对象：
       * v14 曾用 Object.assign(d, ...) 换新对象，FATAL 仍指旧对象，
       * 之后写入的 mount/trackErr 全进孤儿对象，diag 文件永远看不到（实测翻车）。 */
      var d = window.__zusageDiag;
      d.time = new Date().toISOString();
      d.version = VERSION;
      d.href = String(location.href).slice(0, 90);
      var shallow = {};
      COMPOSER_SEL.split(",").forEach(function (sel) {
        try { shallow[sel.trim()] = document.querySelectorAll(sel).length; } catch (e) { }
      });
      d.shallow = shallow;
      d.iframes = document.querySelectorAll("iframe").length;
      var sr = 0;
      (function walk(doc) {
        if (!doc || !doc.querySelectorAll) return;
        var all;
        try { all = doc.querySelectorAll("*"); } catch (e) { return; }
        for (var i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) { sr++; walk(all[i].shadowRoot); }
        }
      })(document);
      d.shadowRoots = sr;
      if (extra) Object.assign(d, extra);
    }

    /* 每实例只归还自己占用的卡片，不能清掉其它 pane 的让位边距。 */
    var paddedCard = null, originalMargin = "", originalMarginPriority = "", pillLayoutAnchor = null, pillMarginFloor = 0, lastPillMargin = "", lastPillHeight = 0, lastPillGeometry = "";
    var pillMoveCheck = null, pillUnmovable = false, pillUnsafe = false, pillBottomLimit = null;
    function releasePads() {
      if (!paddedCard) return;
      if (!lastPillMargin || paddedCard.style.marginBottom === lastPillMargin) {
        if (originalMarginPriority && paddedCard.style.setProperty) paddedCard.style.setProperty("margin-bottom", originalMargin, originalMarginPriority);
        else paddedCard.style.marginBottom = originalMargin;
      }
      delete paddedCard.dataset.zuCardPad;
      paddedCard = null;
      pillMarginFloor = 0;
      lastPillMargin = "";
      lastPillHeight = 0;
      lastPillGeometry = "";
      pillMoveCheck = null;
      pillUnmovable = false;
      pillUnsafe = false;
      pillBottomLimit = null;
    }
    function pillMarginTarget() {
      if (!pillSurface) return cardCache;
      try { return pillSurface.closest('.chat-composer-input-surface') || pillSurface; } catch (e) { return pillSurface; }
    }
    function adjustPillBottom() {
      if (state.theme !== "pill" || !paddedCard || !pillSurface || !bar.offsetHeight) return;
      var dock = null;
      try { dock = paddedCard.closest('[data-v4-composer-dock-content="true"]'); } catch (e) { }
      var anchorRect = (pillLayoutAnchor || pillSurface).getBoundingClientRect();
      var dockRect = dock ? dock.getBoundingClientRect() : (paddedCard.parentElement && paddedCard.parentElement.getBoundingClientRect());
      if (!dockRect) return;
      var sizeKey = innerWidth + ":" + innerHeight + ":" + Math.round(dockRect.width || 0) + ":" + bar.offsetHeight;
      try { if (dock) sizeKey += ":" + getComputedStyle(dock).paddingBottom; } catch (e) { }
      if (sizeKey !== lastPillGeometry) {
        lastPillGeometry = sizeKey;
        pillMoveCheck = null;
        pillUnmovable = false;
        pillUnsafe = false;
        lastPillMargin = Math.max(pillMarginFloor, bar.offsetHeight) + "px";
        paddedCard.style.marginBottom = lastPillMargin;
        anchorRect = (pillLayoutAnchor || pillSurface).getBoundingClientRect();
      }
      var pane = null;
      try { pane = composer.closest('[data-testid^="v4-pane-shell-"]'); } catch (e) { }
      var paneRect = pane && pane.getBoundingClientRect();
      var bottom = paneRect ? Math.min(innerHeight, paneRect.bottom) : innerHeight;
      pillBottomLimit = bottom;
      var dockHeight = dockRect.height || Math.max(0, dockRect.bottom - dockRect.top);
      var nearBottom = dockHeight > 0 && Math.abs(bottom - dockRect.bottom) <= dockHeight / 2;
      var goal = bottom - bar.offsetHeight - 16;
      if (pillMoveCheck) {
        if (pillMoveCheck.bottom - anchorRect.bottom < 1) pillUnmovable = true;
        pillMoveCheck = null;
      }
      pillUnsafe = anchorRect.bottom > goal + 1;
      if (!nearBottom || pillUnmovable) return;
      var current = parseFloat(paddedCard.style.marginBottom) || 0;
      var delta = anchorRect.bottom - goal;
      if (delta <= 1) return;
      var next = Math.max(pillMarginFloor, Math.ceil(current + delta));
      if (Math.abs(next - current) <= 1) return;
      pillMoveCheck = { bottom: anchorRect.bottom };
      lastPillMargin = next + "px";
      paddedCard.style.marginBottom = lastPillMargin;
    }
    var CARD_MARGIN = "24px";
    function ensureCardPad() {
      var target = state.theme === "pill" && pillSurface ? pillMarginTarget() : cardCache;
      if (!target) return;
      if (paddedCard !== target) {
        releasePads();
        paddedCard = target;
        originalMargin = target.style.marginBottom || "";
        originalMarginPriority = target.style.getPropertyPriority ? target.style.getPropertyPriority("margin-bottom") : "";
        try { pillMarginFloor = Math.max(0, parseFloat(getComputedStyle(target).marginBottom) || 0); } catch (e) { pillMarginFloor = 0; }
        target.dataset.zuCardPad = originalMargin;
      }
      if (state.theme !== "pill") {
        if (target.style.marginBottom !== CARD_MARGIN) target.style.marginBottom = CARD_MARGIN;
        lastPillMargin = CARD_MARGIN;
        return;
      }
      var height = bar.offsetHeight || 0;
      if (!height) return;
      if (lastPillMargin && target.style.marginBottom !== lastPillMargin) {
        originalMargin = target.style.marginBottom || "";
        originalMarginPriority = target.style.getPropertyPriority ? target.style.getPropertyPriority("margin-bottom") : "";
        try { pillMarginFloor = Math.max(0, parseFloat(getComputedStyle(target).marginBottom) || 0); } catch (e) { pillMarginFloor = 0; }
        target.dataset.zuCardPad = originalMargin;
        lastPillMargin = "";
      }
      if (!lastPillMargin || lastPillHeight !== height) {
        lastPillMargin = Math.max(pillMarginFloor, Math.ceil(height)) + "px";
        lastPillHeight = height;
        target.style.marginBottom = lastPillMargin;
      }
    }

    /* 从 textarea 向上找视觉卡片容器（有可见边框或背景的最近祖先）——条的锚点 + 读原生总量按钮 */
    function isVisualBox(el) {
      try {
        var cs = getComputedStyle(el);
        return cs.borderTopWidth !== "0px" || cs.backgroundColor !== "rgba(0, 0, 0, 0)";
      } catch (e) { return false; }
    }
    function cardOf(el) {
      var cr = el.getBoundingClientRect();
      var p = el.parentElement, last = el, i = 0;
      for (; p && p !== document.body && i < 8; p = p.parentElement, i++) {
        var r = p.getBoundingClientRect();
        if (r.height > cr.height * 8 + 80) break;          // 会话级大容器（高度异常）
        if (isVisualBox(p)) return p;                       // 第一个有边框/背景的层 = 视觉卡片
        last = p;
      }
      return last;
    }
    /* 权限确认面板内的锚点改判：composer 被面板顶掉（display:none）后，面板里的
     * 反馈输入框是该 pane 唯一候选——它比面板卡矮得多，cardOf 的高度熔断会在到达面板卡
     * 之前 break，落到面板内部的选项/反馈包裹层，条就冒进面板里（最初的 bug：确认时条
     * 跑进对话框）。输入框带 data-permission-* 标记（或卡片自带的数据标记）时改判面板
     * 视觉卡：第一个「有边框且有背景」的祖先（选项按钮只有背景无边框会跳过，rounded-2xl
     * 面板卡二者俱全）。
     * 普通输入框不走这条（closest 不命中），行为与 v62 完全一致。 */
    function isCardLike(el) {
      try {
        var cs = getComputedStyle(el);
        return cs.borderTopWidth !== "0px" && cs.backgroundColor !== "rgba(0, 0, 0, 0)";
      } catch (e) { return false; }
    }
    function panelCardOf(el) {
      try {
        /* 权限面板与批准框（elicitation）同组件，卡片自带该标记（rounded-2xl 视觉卡），
         * 直接锚卡片——选项行聚焦/填写时带底色也会被 cardOf 误判成视觉盒，锚了它条会落进卡片里 */
        var card = el.closest("[data-elicitation-dialog-card]");
        if (card) return card;
        if (!el.closest('[data-permission-option-kind],[data-permission-feedback-option],[data-permission-rule-scopes]')) return null;
      } catch (e) { return null; }
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (isCardLike(p)) return p;
      }
      return null;
    }
    function anchorCardOf(el) {
      return panelCardOf(el) || cardOf(el);
    }
    function composerCardOf(el) {
      try {
        if (el && el.getAttribute && el.getAttribute("data-testid") === "v4-composer-input") {
          var shell = el.closest('.chat-composer-input-surface');
          var layout = el.closest('[data-composer-layout]');
          if (shell && layout && shell.contains(layout)) return layout;
        }
      } catch (e) { }
      return anchorCardOf(el);
    }
    /* 读原生 UI 的上下文总量（输入框工具行按钮的文本/aria-label，如"…总量 1,000,000"）。
     * 服务端下发、自动跟随模型，优先级高于 catalog 查表和 config fallback。 */
    var nativeCtx = { val: 0, at: 0 };
    function readNativeCtx(card) {
      if (Date.now() - nativeCtx.at < 5000) return nativeCtx.val;
      nativeCtx.at = Date.now();
      var els = card.querySelectorAll("button, [aria-label], [title]");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var t = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "";
        var m = t.match(/总量\s*([\d,，]+)/);
        if (m) {
          nativeCtx.val = parseInt(m[1].replace(/[,,]/g, ""), 10);
          return nativeCtx.val;
        }
      }
      return nativeCtx.val;
    }
    /* 解析原生上下文按钮 aria-label 的已用/总量（zh「上下文已用 X / 总量 Y」/ en "Context usage
     * X of Y"，chat.contextUsage；数字是普通千分位格式，面板摘要才是 compact 万/K 格式，不同源）。
     * 数据出自宿主 taskUsage store——与悬停面板同源，压缩后立即回落，比 DB 最近完成请求
     * 新鲜（issue #172）。解析不出（无数据回退标签等）返回 null。 */
    function parseNativeCtxLabel(label) {
      var t = String(label || "");
      var m = t.match(/已用\s*([\d,，]+)\s*\/\s*总量\s*([\d,，]+)/) ||
              t.match(/usage\s*([\d,，]+)\s*of\s*([\d,，]+)/i);
      if (!m) return null;
      /* 剥离类与匹配类同含全角逗号：match 认了 strip 不认会静默截断成错值（review 2026-10-31） */
      var used = parseFloat(m[1].replace(/[,，]/g, "")), total = parseFloat(m[2].replace(/[,，]/g, ""));
      if (!isFinite(used) || !isFinite(total) || used < 0 || total <= 0) return null;
      return { used: used, total: total, pct: Math.min(Math.max(used / total, 0), 1) * 100 };
    }

    /* ---------- v92 原生上下文按钮增强（v93 起档位口径唯一承载处）：环填充与右侧百分比 ----------
     * 按钮（chat-context-usage-trigger）与本条同 pane 同会话：数据优先镜像原生 aria-label
     * （宿主 taskUsage store，压缩后立即更新，issue #172），解析不出时回退本实例 lastBand
     * （DB 最近完成请求口径，ctxOv/nativeCtxVal 的 cw 优先级只作用于此兜底路径）。
     * 稳定性依据：React 不清理非 props 的手动 data-* 属性，也不动 wrapper 末尾追加的
     * 节点（其 React children 只有 button）；dasharray/dashoffset 属 React 管理，宿主
     * 数据更新瞬间会重写，由 render + heavy 双 reapply 兜回（≤600ms）。
     * 两源都无数据时还原原生形态（按钮仍承载 Coding Plan/Start Plan 面板，不动其存在性）。 */
    var ZU_CTX_TRIGGER = '[data-testid="chat-context-usage-trigger"]';
    var ZU_CTX_CIRC = 62.83185307179586;   // 原生环 r=10 的周长（还原原生 dashoffset 用）
    function enhanceCtxButton() {
      if (inactive()) return;
      var btn = null;
      try { btn = cardCache ? cardCache.querySelector(ZU_CTX_TRIGGER) : null; } catch (e) { }
      /* v156 增强开关关闭：还原原生环/百分比（restoreCtxButton 顺带清徽标，随后重挂），
       * 重置卡徽标仅借按钮做定位锚点，独立于增强继续维护 */
      if (!state.ctxEnh) {
        if (ctxBtnCache) { restoreCtxButton(ctxBtnCache); ctxBtnCache = null; }
        if (btn && btn.parentElement) syncResetBadge(btn);
        return;
      }
      var nat = null;
      try { nat = parseNativeCtxLabel(btn && btn.getAttribute("aria-label")); } catch (e) { }
      if (!btn || !btn.parentElement || (!nat && (!lastBand || !lastBand.cw))) {
        if (ctxBtnCache) { restoreCtxButton(ctxBtnCache); ctxBtnCache = null; }
        return;
      }
      /* 原生可解析时以原生占比显示（分档同表重算，exc 过程态仍优先）；lastBand 继续按 DB
       * 口径供给 acWarningText 等消费方，不在此改写。 */
      var band = lastBand;
      if (nat) band = {
        cw: nat.total, pct: nat.pct,
        exc: !!(lastBand && lastBand.exc),
        cls: lastBand && lastBand.exc ? "exc" : bandOf(CTX_BANDS, nat.pct),
      };
      ctxBtnCache = btn;
      if (btn.getAttribute("data-zusage-armed") !== "1") btn.setAttribute("data-zusage-armed", "1");
      if (btn.getAttribute("data-zusage-band") !== band.cls) btn.setAttribute("data-zusage-band", band.cls);
      var lite = bar.classList.contains("zu-light");
      syncCtxLite(btn, lite);
      var svg = null;   // 排除 .animate-spin：额度重置中 spinner 保留原生转圈，期间环回原生样式
      for (var i = 0; i < btn.children.length; i++) {
        var k = btn.children[i];
        if (String(k.tagName || "").toLowerCase() === "svg" && !(k.classList && k.classList.contains("animate-spin"))) { svg = k; break; }
      }
      if (svg) {
        var cs = svg.querySelectorAll("circle");
        var v = cs.length >= 2 ? cs[1] : null;
        if (v) {
          var da = Math.max(0, Math.min(100, band.pct)).toFixed(1) + " 100";
          if (v.getAttribute("pathLength") !== "100") v.setAttribute("pathLength", "100");
          if (v.getAttribute("stroke-dasharray") !== da) v.setAttribute("stroke-dasharray", da);
          if (v.getAttribute("stroke-dashoffset") !== "0") v.setAttribute("stroke-dashoffset", "0");
          if (v.getAttribute("stroke-linecap") !== "round") v.setAttribute("stroke-linecap", "round");
        }
      }
      var pctEl = null;
      for (var j = 0; j < btn.children.length; j++) {
        if (btn.children[j].classList && btn.children[j].classList.contains("zu-ctxpct")) { pctEl = btn.children[j]; break; }
      }
      if (!pctEl) {
        pctEl = document.createElement("span");
        pctEl.className = "zu-ctxpct";
        btn.appendChild(pctEl);   // 挂在 trigger 按钮内：悬停数值=悬停按钮，原生 hover 效果与「上下文容量」面板自动生效
      } else if (pctEl !== btn.children[btn.children.length - 1]) {
        btn.appendChild(pctEl);   // React 提交（如额度重置 loading 切换的 appendChild）可能把手动节点挤离末尾，挪回环右侧
      }
      var txt = band.pct.toFixed(1) + "%";
      var pcls = "zu-ctxpct pct " + band.cls;
      if (pctEl.textContent !== txt) pctEl.textContent = txt;
      if (pctEl.className !== pcls) pctEl.className = pcls;
      syncResetBadge(btn);
    }
    /* ---------- v135 重置卡徽标（.zu-ctxrst，工具行内额度组左侧） ----------
     * 数据：快照 quota.resets（独立 reset 链，账号族级，与额度 chip 开关无关）。
     * 内容：单族「重置 · N」，多族各账号张数 + 连接（重置 · 2+3）；剩余 < 阈值
     * （state.resetCdh 小时，默认 24）追加倒计时（取全局最早到期卡）。三档色按剩余时间：
     * >3h 绿 / 3h–30min 黄 / <30min 红+呼吸。挂载点随用户规格两次迁移：按钮内 → wrapper 内
     * 按钮右侧 → 工具行内、wrapper（额度 chip+上下文按钮组）左侧（2026-10-28 定稿）。
     * 工具行插入与 Git chip 同属 React 兄弟区（外来节点不复用不清理），位置由双 reapply 兜回；
     * 卡到期但数据未刷新（expireAt<=now）按无卡处理，绝不显示过期倒计时。 */
    function resetBadgeView() {
      if (!state.resetBadge || !lastResets) return null;
      /* 只信本 pane 的实时个人编码套餐选择；旧宿主无 marker 时不借历史请求或全局回退，
       * apiKey、团队与 Start Plan 也不能证明对应个人重置卡的归属。 */
      var provider = quotaSelection && quotaSelection.providerId;
      if (provider !== "account:bigmodel-individual-coding-plan" &&
          provider !== "account:zai-individual-coding-plan") return null;
      var now = Date.now(), earliest = 0, total = 0, fams = [], counts = [];
      ["bigmodel", "zai"].forEach(function (name) {
        var e = lastResets[name], count = 0;
        if (!e || typeof e !== "object") return;
        [e.fiveHour, e.week].forEach(function (cards) {
          if (!Array.isArray(cards)) return;
          cards.forEach(function (card) {
            var t = card && card.expireAt;
            if (typeof t !== "number" || !isFinite(t) || t <= now) return;
            count++;
            if (!earliest || t < earliest) earliest = t;
          });
        });
        if (count) { total += count; counts.push(String(count)); fams.push({ fam: name, entry: e }); }
      });
      if (!total) return null;
      var rem = earliest - now;
      var band = "zu-rst-calm";
      for (var bi = 0; bi < RST_BANDS.length; bi++) {
        if (rem <= RST_BANDS[bi].max) { band = RST_BANDS[bi].cls; break; }
      }
      var countdown = "";
      var cdh = state.resetCdh >= 1 ? state.resetCdh : 24;
      if (rem < cdh * 3600 * 1000) countdown = " · " + rstSpanText(rem);
      return { fams: fams, text: counts.join("+"), countdown: countdown,
        band: band, earliest: earliest, total: total };
    }
    function rstSpanText(rem) {   // 时分秒全档恒显（用户规格 2026-10-28：精确到秒、实时逐秒跳动）；中文紧邻、英文数字单位紧邻+时段间空格
      var segGap = L("", " ");
      var uh = L("时", "h"), um = L("分", "m"), us = L("秒", "s");
      var total = Math.max(0, Math.floor(rem / 1000));
      var hours = Math.floor(total / 3600), mins = Math.floor(total / 60) % 60, secs = total % 60;
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      if (state.lang === "en") {
        return [hours + uh, pad(mins) + um, pad(secs) + us].join(segGap);
      }
      return hours + uh + pad(mins) + um + pad(secs) + us;
    }
    function syncResetBadge(btn) {
      var wrap = btn.parentElement;
      if (!wrap || !wrap.parentElement) return;
      var host = wrap.parentElement;   // 工具行（group/toolbar）：与 Git chip 同级的 React 兄弟插入区
      var el = null;
      for (var i = 0; i < host.children.length; i++) {
        if (host.children[i].classList && host.children[i].classList.contains("zu-ctxrst")) { el = host.children[i]; break; }
      }
      var v = resetBadgeView();
      if (!v) {
        if (el) { if (rstTipFor === el) hideRstTip(); el.remove(); }
        return;
      }
      if (!el) {
        el = document.createElement("span");
        el.className = "zu-ctxrst";
        el.tabIndex = 0;
        el.addEventListener("keydown", function (e) { if (e.key === "Escape") hideRstTip(); });   // v118 键盘可达契约
        el.addEventListener("mouseenter", function () { cancelRstHide(); showRstTip(this); });
        el.addEventListener("mouseleave", scheduleRstHide);   // 延迟收起：给指针移入 tooltip 点「如何重置」留窗口
        el.addEventListener("focus", function () { showRstTip(this); });
        el.addEventListener("blur", hideRstTip);
        host.appendChild(el);
      }
      if (el.nextSibling !== wrap) host.insertBefore(el, wrap);   // 位置兜回：额度组（wrapper）左侧
      var txt = v.text + v.countdown;
      /* lucide refresh-cw：双箭头环形 = 通用「重置」视觉语言；此前卡内嵌箭头的复合图标
       * 在 14px 下墨迹过密显糊（用户反馈 2026-10-28） */
      var html = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>' + txt;   // 图标↔数字间距走 .zu-ctxrst>svg margin（字面空格在 flex 里渲染不稳定）
      if (el.__zuSig !== html) { el.innerHTML = html; el.__zuSig = html; }
      el.setAttribute("aria-label", L("额度重置卡 ", "Quota reset cards ") + txt);
      var cls = "zu-ctxrst " + v.band + (v.countdown ? " zu-rst-cd" : "");
      if (el.className !== cls) el.className = cls;
      el.__zuR = v;
      if (rstTipFor === el) showRstTip(el);   // 悬停时随数据及到期状态刷新；内容签名不变不重建
    }
    function syncCtxLite(el, lite) {
      var has = el.getAttribute && el.getAttribute("data-zusage-light");
      if (lite && !has) el.setAttribute("data-zusage-light", "1");
      else if (!lite && has) el.removeAttribute("data-zusage-light");
    }
    function restoreCtxButton(btn) {
      if (!btn || !btn.isConnected) return;
      btn.removeAttribute("data-zusage-armed");
      btn.removeAttribute("data-zusage-band");
      btn.removeAttribute("data-zusage-light");
      for (var i = 0; i < btn.children.length; i++) {
        if (btn.children[i].classList && btn.children[i].classList.contains("zu-ctxpct")) { btn.children[i].remove(); break; }
      }
      /* 重置徽标可能随历史版本留在 wrapper 内或工具行（挂载点迁移过），两处都清 */
      for (var scope = 0; scope < 2; scope++) {
        var rstHost = scope === 0 ? btn.parentElement : btn.parentElement && btn.parentElement.parentElement;
        for (var r = 0; rstHost && r < rstHost.children.length; r++) {
          if (rstHost.children[r].classList && rstHost.children[r].classList.contains("zu-ctxrst")) {
            if (rstTipFor === rstHost.children[r]) hideRstTip();
            rstHost.children[r].remove();
            break;
          }
        }
      }
      var cs = btn.querySelectorAll("circle");
      var v = cs.length >= 2 ? cs[1] : null;
      if (v) {
        v.removeAttribute("pathLength");
        v.removeAttribute("stroke-linecap");
        /* 还原原生 dash 语义：aria-label「上下文已用 X / 总量 Y」推回 offset；拿不到就退
         * 空环（offset=周长），React 数据更新时会写回准确值。 */
        var ratio = 0, nat = parseNativeCtxLabel(btn.getAttribute("aria-label"));
        if (nat) ratio = nat.pct / 100;
        v.setAttribute("stroke-dasharray", ZU_CTX_CIRC + " " + ZU_CTX_CIRC);
        v.setAttribute("stroke-dashoffset", String(ZU_CTX_CIRC * (1 - ratio)));
      }
    }

    /* ---------- v146 精简模式速率 chip（.zu-tsb）：工具行、重置卡左侧 ----------
     * 仅精简主题挂载（其余主题 restoreTpsChip 摘除）。挂载面与重置卡同源：工具行的
     * React 兄弟插入区，位置兜回 = 额度组 wrapper（或重置卡）左侧；双 reapply
     * （render/updateLive 数据点 + heavy 对账点）+ __zuSig 签名幂等。内容与条面
     * 速度 chip 同源（zuBarSpeedView 桥两态 / tpsBand DB 回退），无有效样本不渲染
     * （与条面口径一致：用户拍板「无数据隐藏」，代价是新会话首次请求前无设置入口）。 */
    function tpsChipView() {
      var cAvg = (lastView && lastView.session && typeof lastView.session.avg_tps === "number" &&
                  isFinite(lastView.session.avg_tps) && lastView.session.avg_tps > 0) ? lastView.session.avg_tps : 0;
      var sv = liveStatsCur ? zuBarSpeedView(liveStatsCur, bridge.handle && bridge.handle.charsPerToken, subRate.sum, cAvg) : null;
      if (sv) {
        liveKindCur = "live";
        livePhaseCur = sv.phase || "";
        return { kind: "live", sv: sv };
      }
      var dbTps = lastView && lastView.last ? lastView.last.tps : 0;
      if ((cAvg || dbTps) && isFinite(cAvg || dbTps) && (cAvg || dbTps) > 0) {
        liveKindCur = "fallback";
        livePhaseCur = "";
        return { kind: "fallback", dbTps: dbTps, sessAvg: cAvg, band: tpsBand(cAvg || dbTps) };
      }
      liveKindCur = "none";
      livePhaseCur = "";
      return null;
    }
    function tpsRowHtml(k, v) {
      return '<div class="tps-row"><span class="tps-k">' + k + '</span><span class="tps-v">' + ttEsc(v) + "</span></div>";
    }
    function tpsChipTipHTML(t) {
      var v = t.v, view = t.view || {};
      var sess = view.session || {}, lt = view.last_turn || {}, today = view.today || {}, last = view.last || {};
      var tls = view.tools || { total: 0, errors: 0 };
      /* 作用域样式挂在内容串里（同 rstTipHTML）：浮层是 body 级共享元素，样式随内容走 */
      var out = "<style>" +
        ".zusage-tps-tip .tps-h{font-weight:600;margin:0 0 7px}" +
        ".zusage-tps-tip .tps-sec{font-weight:600;margin:9px 0 2px}" +
        ".zusage-tps-tip .tps-row{display:flex;gap:10px;margin:4px 0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}" +
        ".zusage-tps-tip .tps-k{flex:0 0 auto;min-width:76px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
        ".zusage-tps-tip .tps-v{flex:1;min-width:0}" +
        ".zusage-tps-tip .tps-subrow{cursor:pointer}" +
        ".zusage-tps-tip .tps-subrow:hover .tps-v{color:var(--color-tooltip-foreground,#fafafa);text-decoration:underline}" +
        ".zusage-tps-tip .tps-note{display:flex;align-items:center;gap:10px;margin-top:8px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent));color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
        ".zusage-tps-tip .tps-note-t{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}" +
        ".zusage-tps-tip .tps-cfg{flex:0 0 auto;margin-left:auto;background:none;border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:999px;color:inherit;font:inherit;font-size:.85em;line-height:1.5;padding:0 9px;cursor:pointer}" +
        ".zusage-tps-tip .tps-cfg:hover{color:var(--color-tooltip-foreground,#fafafa);border-color:var(--color-border-hover,rgba(255,255,255,.24))}" +
        "</style>";
      var speedMain, speedMainCls = "", speedScope, speedSubLabel = "", speedSub = "", speedBandTag = "";
      if (v.kind === "live") {
        speedScope = v.sv.phase ? L("生成中估算", "Running estimate") : L("本轮完成 · 真实值", "Turn completed · actual");
        speedMain = v.sv.text;
        speedMainCls = (v.sv && v.sv.cls) || "";
        if (v.sv && typeof v.sv.latest === "number") { speedSubLabel = L("最近一轮", "Latest turn"); speedSub = v.sv.latest.toFixed(1); }
        speedBandTag = (v.sv && v.sv.band) ? tpsBandText(v.sv.band) : "";
      } else {
        var mainTpsC = v.sessAvg || v.dbTps;
        var bandC = tpsBand(typeof mainTpsC === "number" && isFinite(mainTpsC) ? mainTpsC : -1);   // 非数值（布尔旗标等）不入档
        speedScope = v.sessAvg ? L("会话平均", "Session average") : L("最近一段", "Latest segment");
        speedMain = (mainTpsC % 1 ? mainTpsC.toFixed(1) : String(mainTpsC));
        speedMainCls = bandC.cls;
        speedSubLabel = (v.sessAvg && v.dbTps > 0) ? L("最近一段", "Latest segment") : "";
        speedSub = (v.sessAvg && v.dbTps > 0) ? String(v.dbTps) : "";
        speedBandTag = tpsBandText(v.band);
      }
      /* v222：时间范围行——会话均/桥态取会话累计口径，「最近一段」回退态取段范围
       * （与会话累计 tooltip 同款式）。 */
      var chipSpan = (v.kind === "live" || v.sessAvg)
        ? speedSpan(sess.started, sess.last_at)
        : speedSpan(last.startedAt, last.endedAt);
      /* v255：精简模式速度 chip 也走 V2 整卡（此前只接了全量状态条两条路径，
       * compact 下 hover 一直显示旧「统计口径 + 10 根粗柱」）。筛选/悬停状态挂数据包，
       * tpsTip 浮层委托见模块层；旧快照缺轮表时原样回退旧摘要卡。 */
      var cv2 = spdRebuildOr(t && t.speedHistory, (t && t.speedSel) ||
        { range: "recent", period: "recent", dim: "time" },
        (t && typeof t.speedHover === "number") ? t.speedHover : -1, t && t.speedLive,
        { fmtTok: fmt, fmtCnt: countFmt, fmtMoney: state.cost ? fmtMoney : null }, sess);
      if (cv2) return cv2((t && typeof t.speedHover === "number") ? t.speedHover : -1, t.speedSel);
      try { FATAL.spdTip = { t: Date.now(), src: "fb-chip",
        turns: t && t.speedHistory && t.speedHistory.turns ? t.speedHistory.turns.length : -1 }; } catch (_) { }
      out += speedCardHTML({
        scope: speedScope,
        main: speedMain,
        mainCls: speedMainCls,
        noUnit: v.kind === "live" && v.sv && v.sv.phase,
        subLabel: speedSubLabel,
        sub: speedSub,
        bandTag: speedBandTag,
        curCls: speedMainCls,
        timeStart: chipSpan ? chipSpan.start : "",
        timeEnd: chipSpan ? chipSpan.end : "",
        basisTitle: L("统计口径", "Basis"),
        basisText: v.kind === "live"
          ? [L("按文本增量算出的字符/s，除以「每 token 字符数」估算 tok/s；比例取自本会话最近完成的真实轮次。", "chars/s from text deltas divided by a chars-per-token ratio calibrated from this session's latest completed turn.")]
          : (v.sessAvg
            ? [L("Σ输出（含思考）÷ 生成耗时", "Σoutput (thinking incl.) ÷ generation time")]
            : [L("输出 tokens（含思考）÷ 生成耗时", "output tokens (thinking incl.) ÷ generation time")])
      });
      /* 状态条摘要（用户拍板：隐藏格数据收进速率 tooltip）：逐格开关继续生效——
       * 关掉的格不出摘要行；子代理行可点击开明细面板（条面 .zu-sub 格的替身入口）。 */
      out += '<div class="tps-sec">' + L("状态条摘要", "Bar summary") + "</div>";
      if (state.show.turn) {
        out += tpsRowHtml(L("本轮", "Latest turn"), fmt(lt.total) + L(" token · ", " token · ") + countFmt(lt.requests || 0) + L("次", " req") + (lt.avg_duration_ms ? " · " + sec(lt.avg_duration_ms) : "") + costSuffix(lt.cost_usd));   /* v211 摘要时长随格面口径改平均值 */
      }
      if (state.show.win) {
        out += tpsRowHtml(L("会话累计", "Session"), fmt(sess.total) + L(" token · ", " token · ") + countFmt(sess.requests || 0) + L("次", " req") + costSuffix(sess.cost_usd));
      }
      if (state.show.today) {   // v213 摘要行序随格序对齐（用户规格 2026-11-02）
        out += tpsRowHtml(L("今日合计", "Today"), fmt(today.total) + L(" token · ", " token · ") + countFmt(today.requests || 0) + L("次", " req") + costSuffix(today.cost_usd));
      }
      if (state.show.proj && sess.project) {   // v159：项目累计摘要行（与会话累计同款口径）
        var pj2 = sess.project;
        out += tpsRowHtml(L("项目累计", "Project"), fmt(pj2.total) + L(" token · ", " token · ") + countFmt(pj2.sessions || 0) + L("会话 · ", " sessions · ") + countFmt(pj2.requests || 0) + L("次", " req") + costSuffix(pj2.cost_usd));
      }
      if (state.show.tools) {
        out += tpsRowHtml(L("工具调用", "Tool calls"), countFmt(tls.total || 0) + (tls.errors ? L("（错误 ", " (errors ") + countFmt(tls.errors) + "）" : ""));
      }
      if (state.show.sub) {
        var subA = view.sub || { total: 0, active: false };
        out += '<div class="tps-row tps-subrow" data-zusage-sub="1"><span class="tps-k">' + L("子代理", "Sub-agents") + '</span><span class="tps-v">' +
          ttEsc(fmt(subA.total || 0) + L(" token", " token") + (subA.active ? L(" · 运行中", " · running") : "") + L(" · 点击查看", " · click to view")) + "</span></div>";
      }
      out += modelsBlock(sess.models);   // v202：模型统计明细（含费用与 ? 图标，与统计格同构）
      out += tpsBandLegend(speedMainCls);
      out += '<div class="tps-note"><span class="tps-note-t">' + L("精简模式：状态条已收进工具行，各图标悬停看明细。", "Compact mode: the status bar lives in the toolbar — hover the chips for details.") +
        '</span><button type="button" class="tps-cfg">' + L("打开设置", "Open settings") + "</button></div>";
      return out;
    }
    function wireTpsChip(chip) {
      chip.__zuWired = true;
      /* 「打开设置」镜像齿轮开启分支（previousPanelFocus 落在 chip 上，关闭时焦点归还）；
       * 子代理行复用统一浮层开关（positionSubPop 在精简下贴 chip 定位）。 */
      chip.__zuOpen = function () {
        if (panel.classList.contains("open")) return;
        previousPanelFocus = chip;
        panel.classList.add("open");   /* 同齿轮路径：先 .open 后 syncPanel */
        try { syncPanel(); } catch (eChipSync) { panel.classList.remove("open"); throw eChipSync; }
        panel.setAttribute("aria-modal", "false");
        gear.setAttribute("aria-expanded", "true");
        panel.style.height = "";
        positionSettingsPanel();
        subPopClose(false, "chip-open");
        var activeNav = panel.querySelector('.zu-navitem[aria-current="page"]');
        if (activeNav && activeNav.focus) activeNav.focus();
      };
      /* v217：精简入口同样开统一浮层（chip 自身已有速率 tooltip，只走 pinned 不做预览） */
      chip.__zuOpenSub = function () {
        if (subPopMode === "pinned") subPopClose(false, "chip");
        else subPopShow(chip, true);
      };
      chip.addEventListener("mouseenter", function () { cancelTpsHide(); showTpsTip(chip); });
      chip.addEventListener("mouseleave", scheduleTpsHide);   // 延迟收起：给指针移入 tooltip 留窗口（同重置卡桥）
      chip.addEventListener("focus", function () { showTpsTip(chip); });
      chip.addEventListener("blur", hideTpsTip);
      chip.addEventListener("keydown", function (e) { if (e.key === "Escape") hideTpsTip(); });
    }
    function syncTpsChip() {
      if (state.theme !== "compact") { restoreTpsChip(); return; }   // v146：速率 chip 是精简模式专属载体
      if (inactive()) { restoreTpsChip(); return; }
      var v = tpsChipView();
      if (!v) { restoreTpsChip(); return; }
      /* v147 挂载面（用户规格）：前导区、git chip 左侧——git 在时插它前面；git 不在时占其
       * 锚位（cua-entry 后方/前导区末尾），git 出现后两侧兜回收敛为 [锚][速率][git]
       * （git 的兜回容忍速率占相邻位，见 enhanceGitChip，否则逐拍互相拉锯）。
       * 前导区发现失败（异形布局）回落尾随区：重置卡/额度组 wrapper 左侧（v146 原挂载面）。 */
      var host = null, insBefore = null, afterNode = null;   // insBefore=插其前；afterNode=挂其后（锚位语义，与 git chip 同款）
      var mount = null;
      try { mount = gitMount(); } catch (e) { }
      if (mount) {
        host = mount.wrap;
        var g = null;
        for (var gi = 0; gi < host.children.length; gi++) {
          if (host.children[gi].classList && host.children[gi].classList.contains("zu-git")) { g = host.children[gi]; break; }
        }
        if (g) insBefore = g;            // git 在：速率紧贴其左
        else afterNode = mount.after;    // git 不在：占其锚位（cua-entry 后方；after=null=前导区末尾）
      } else {
        var btn = null;
        try { btn = (ctxBtnCache && ctxBtnCache.isConnected) ? ctxBtnCache : (cardCache ? cardCache.querySelector(ZU_CTX_TRIGGER) : null); } catch (e) { }
        if (!btn || !btn.parentElement || !btn.parentElement.parentElement) { restoreTpsChip(); return; }
        var wrap = btn.parentElement;
        host = wrap.parentElement;   // 工具行（group/toolbar）：与重置卡/额度组同一 React 兄弟插入区
        insBefore = wrap;
        for (var r = 0; r < host.children.length; r++) {
          if (host.children[r].classList && host.children[r].classList.contains("zu-ctxrst")) { insBefore = host.children[r]; break; }
        }
      }
      var chip = tpsChipCache;
      if (!chip || !chip.isConnected || chip.parentElement !== host) {
        if (chip && chip.isConnected) chip.remove();
        chip = null;
        for (var i = 0; i < host.children.length; i++) {   // 复用遗留节点防双 chip（同额度 chip）
          if (host.children[i].classList && host.children[i].classList.contains("zu-tsb")) { chip = host.children[i]; break; }
        }
        if (!chip) {
          chip = document.createElement("span");
          chip.className = "zu-tsb";
          chip.tabIndex = 0;
          host.appendChild(chip);
        }
        /* v155：新建与跨代采纳统一走挂装（__zuWired 防重）；遗留节点上的旧代监听随
         * __zuOpen 缺失一并补齐，否则热更采纳的 chip 悬停/键盘/设置入口全部失效。 */
        if (!chip.__zuWired) wireTpsChip(chip);
        tpsChipCache = chip;
      }
      var misplaced;
      /* 用 nextElementSibling 判位（nextSibling 会被文本节点打乱，造成每拍重插） */
      if (insBefore) misplaced = chip.nextElementSibling !== insBefore;
      else misplaced = (afterNode ? afterNode.nextElementSibling !== chip : host.lastElementChild !== chip);   // 锚位语义同 git 兜回（下一元素已是自己=就位，不得自插）
      if (misplaced) host.insertBefore(chip, insBefore ? insBefore : (afterNode ? afterNode.nextElementSibling : null));
      var txt = v.kind === "live" ? v.sv.text
        : (v.sessAvg ? L("均", "avg ") + v.sessAvg + " t/s" : v.dbTps + " t/s");   /* v228：去「· 近X」尾缀，与条面格同口径（用户规格） */
      var cls = "zu-live " + (v.kind === "live" ? v.sv.cls + (v.sv.word ? " zu-shimmer" : "") : v.band.cls);
      var sig = v.kind + "|" + cls + "|" + txt;
      if (chip.__zuSig !== sig) {   // 幂等：内容没变不重建，悬停/焦点态不被打断
        chip.__zuSig = sig;
        chip.innerHTML = '<span class="' + cls + '">' + ttEsc(txt) + "</span>";
        chip.setAttribute("aria-label", L("生成速度 ", "Generation speed ") + txt);
      }
      var prevT = chip.__zuT;
      chip.__zuT = { v: v, view: lastView, buildTip: tpsChipTipHTML,
        /* v255：V2 轮表与筛选/悬停状态随 chip 包走，10Hz 心跳不重置用户选择 */
        speedHistory: (state.data && state.data.speed_history) || (prevT && prevT.speedHistory) ||
          (typeof lastSpeedHistory !== "undefined" && lastSpeedHistory) || null,
        speedSel: (prevT && prevT.speedSel) || { range: "recent", period: "recent", dim: "time" },
        speedHover: prevT && typeof prevT.speedHover === "number" ? prevT.speedHover : -1,
        speedLive: v.kind === "live" ? v.sv : null };
      var lite = bar.classList.contains("zu-light");
      syncCtxLite(chip, lite);
      chip.classList.toggle("zu-light", lite);   // 速率档色的浅色组按 .zu-light 祖先匹配（条隐藏后祖先缺失，类挂 chip 自身补链）
      if (tpsTipFor === chip) showTpsTip(chip);   // 悬停中随心跳/推送刷新：签名不变不重建
    }
    function restoreTpsChip() {
      if (!tpsChipCache) return;
      if (tpsTipFor === tpsChipCache) hideTpsTip();
      try { tpsChipCache.remove(); } catch (e) { }
      tpsChipCache = null;
    }

    /* ---------- v96 套餐额度 chip：原生上下文按钮左侧 ----------
     * 挂载面与按钮增强同源：wrapper（tooltip-trigger span）的 React children 只有 button，
     * 前插的手动节点不受 reconcile 清理；双 reapply（render 数据点 + heavy 对账点）兜回位置
     * 与内容；dispose / 关闭开关 / 无数据一律摘除。显示门控：开关开 + 本 pane 会话已有完成的
     * main_turn（provider_id 已知）+ provider 为内置套餐档；自定义 provider 隐藏，团队档给
     * 不支持提示。数据账号级（快照 quota 字段），同套餐换模型只换 tooltip 高亮不重查。 */
    function quotaBandOf(pct) { return bandOf(QUOTA_BANDS, pct); }
    /* chip 分段：每个窗口一段（5小时/7天），各自按已用 % 上档位色；余额类型一段（阶段 3 数据源接入即用） */
    function quotaSegs(q) {
      var w = q && q.windows, out = [];
      if (!w) return out;
      var defs = [["daily", "今日", "1d"], ["fiveHour", "5小时", "5h"], ["weekly", "7天", "7d"], ["monthly", "本月", "1mo"], ["plan", "套餐", "plan"]];
      for (var i = 0; i < defs.length; i++) {
        var e = w[defs[i][0]];
        /* isFinite 门：NaN/±Infinity 不进分段，绝不落成正常色（v127） */
        if (e && typeof e.percent === "number" && isFinite(e.percent)) out.push({ label: L(defs[i][1], defs[i][2]), pct: e.percent });
      }
      return out;
    }
    function quotaChipMode() {
      if (!state.quotaEnabled) return null;
      /* 会话有请求历史 → 跟随本会话最近完成的请求；无历史（新会话/刚切模型）→ 跟随快照
       * 顶层 provider_fallback（账号最近套餐档），消除切模型到首请求完成的 chip 空窗。 */
      var prov = effectiveQuotaProvider();
      if (!prov) return null;
      if (prov.indexOf("account:") === 0 && prov.indexOf("team") >= 0) {
        return { kind: "team", html: '<span class="zu-qwarn">⊘</span>', aria: L("团队套餐额度暂不支持", "Team plan quota not supported yet") };   // 静态提示不依赖数据
      }
      if (!lastQuota) return null;
      /* 按 provider 选源：内置 account:* → family 源；自定义 → byProvider 映射（主进程
       * noteProvider 时记录），未映射的自定义退 custom 源。多窗异 provider 各取各的源。 */
      var q = lastQuota, st = q.status;
      if (st === "disabled") return null;   // 源被 ⚙ 显式关闭：尊重显式关闭，不展示
      if (st === "not_configured" || st === "unsupported") {   // v111 不再静默隐藏：中性灰提示引导去 ⚙ 配置
        var dimTxt = st === "not_configured" ? L("额度 未配置", "Quota unset") : L("额度 暂不支持", "Quota unsupported");
        return { kind: "info", html: '<span class="zu-qseg dim">' + dimTxt + "</span>", aria: dimTxt };
      }
      var warn = (st !== "ok" && st !== "idle") ? '<span class="zu-qwarn">⚠</span>' : "";
      var bal = q.balance;
      if (bal && typeof bal.amount === "number" && isFinite(bal.amount)) {
        var amt = quotaBalanceText(bal);
        return { kind: "balance", stale: !!q.stale, busy: !!q.busy,
          html: '<span class="zu-qseg zu-qb-calm">' + (state.lang === "en" ? "" : "余额 ") + amt + "</span>" + warn,
          aria: L("余额 ", "Balance ") + quotaBalanceText(bal, true) };
      }
      var segs = quotaSegs(q);
      if (segs.length) {
        var rem = state.quotaRemain === 1;   // v251 显示口径：缺省已用%，开启后剩余%（数字取 100−已用的补数）
        var shownOf = function (pct) { return Math.round(rem ? quotaRemainPct(pct) : pct); };
        var html = segs.map(function (s) {
        /* v127：周期标签拆 zu-qlabel 子节点（静态 L() 文案，安全）——标签与数值同档色同字重成组。
         * textContent 与原有完全一致，aria/tooltip 不受影响。档位色恒按已用原始值判定，不随口径反转。 */
          return '<span class="zu-qseg ' + quotaBandOf(s.pct) + '"><span class="zu-qlabel">' + s.label + '</span> ' + shownOf(s.pct) + "%</span>";
        }).join('<span class="zu-qsep">|</span>');
        return { kind: "value", stale: !!q.stale, busy: !!q.busy,
          html: html + warn,
          aria: (rem ? L("套餐剩余 ", "Plan remaining ") : L("套餐已用 ", "Plan used ")) + segs.map(function (s) { return s.label + " " + shownOf(s.pct) + "%"; }).join(L("，", ", ")) };
      }
      var summary = q.quotaSummary;
      if (summary && typeof summary.remaining === "number" && isFinite(summary.remaining)) {
        var left = quotaBalanceText({ amount: summary.remaining, currency: summary.currency });
        return { kind: "quota", stale: !!q.stale, busy: !!q.busy, html: '<span class="zu-qseg zu-qb-calm">' + L("额度 ", "Quota ") + left + "</span>" + warn,
          aria: L("Key 剩余额度 ", "Key quota remaining ") + quotaBalanceText({ amount: summary.remaining, currency: summary.currency }, true) };
      }
      if (st === "ok" || st === "idle") return null;   // 还没有可显示的窗口（首查在途/接口回空）
      return { kind: "error", html: '<span class="zu-qwarn">⚠</span>', aria: quotaStatusText(st) || st };
    }
    function onQuotaClick(e) {
      e.preventDefault();
      e.stopPropagation();
      pluginRequest("quota-refresh", quotaSourceId ? { sourceId: quotaSourceId } : undefined);
    }
    function enhanceQuotaChip() {
      if (inactive()) { restoreQuotaChip(); return; }
      var mode = quotaChipMode();
      if (!mode) { restoreQuotaChip(); return; }
      var btn = null;
      try { btn = (ctxBtnCache && ctxBtnCache.isConnected) ? ctxBtnCache : (cardCache ? cardCache.querySelector(ZU_CTX_TRIGGER) : null); } catch (e) { }
      if (!btn || !btn.parentElement) { restoreQuotaChip(); return; }
      var wrap = btn.parentElement;
      var chip = quotaChipCache;
      if (!chip || !chip.isConnected || chip.parentElement !== wrap) {
        if (chip && chip.isConnected) chip.remove();
        chip = null;
        for (var i = 0; i < wrap.children.length; i++) {   // 复用热更/重建遗留的同类节点，避免双 chip
          if (wrap.children[i].classList && wrap.children[i].classList.contains("zu-quota")) { chip = wrap.children[i]; break; }
        }
        if (!chip) {
          chip = document.createElement("span");
          chip.className = "zu-quota";
          chip.setAttribute("role", "button");
          chip.setAttribute("aria-keyshortcuts", "Enter Space");
          chip.tabIndex = 0;
          chip.addEventListener("mouseenter", onQuotaEnter);
          chip.addEventListener("mouseleave", hideQuotaTip);
          chip.addEventListener("focus", onQuotaEnter);
          chip.addEventListener("blur", hideQuotaTip);
          chip.addEventListener("keydown", onRefreshKeydown);
          chip.addEventListener("keyup", onRefreshKeyup);
          chip.addEventListener("click", onQuotaClick);
        }
        quotaChipCache = chip;
      }
      if (chip.nextElementSibling !== btn) wrap.insertBefore(chip, btn);   // 位置兜回：始终紧贴按钮左侧
      var liveState = lastQuota && lastQuota.busy ? L("套餐额度查询中", "Plan quota query in progress") : mode.aria;
      if (ariaLiveState.__zuQuotaLive !== liveState) {
        ariaLiveState.__zuQuotaLive = liveState;
        ariaLiveState.textContent = ariaLiveState.__zuQuotaLive || ariaLiveState.__zuGitLive || "";
      }
      syncCtxLite(chip, bar.classList.contains("zu-light"));
      var srcLabels = {};
      for (var si = 0; si < (state.quotaSources || []).length; si++) srcLabels[state.quotaSources[si].id] = state.quotaSources[si].label;
      var all = lastQuotaAll && lastQuotaAll.sources ? Object.assign({}, lastQuotaAll, { active: quotaSourceId }) : lastQuotaAll;
      chip.__zuQ = { q: lastQuota, all: all, srcLabels: srcLabels, provider: quotaProvider, model: quotaModel, mode: mode };
      var sig = mode.kind + "|" + (mode.stale ? 1 : 0) + "|" + mode.html;
      var qbusy = !!(lastQuota && lastQuota.busy);
      if (chip.__zuSig !== sig) {   // 幂等：内容没变不重建，悬停/焦点态不被打断
        chip.__zuSig = sig;
        chip.className = "zu-quota" + (mode.stale ? " zu-qstale" : "") + (qbusy ? " zu-qbusy" : "");
        chip.setAttribute("aria-label", mode.aria);
        chip.innerHTML = mode.html;
      }
      chip.classList.toggle("zu-qbusy", qbusy);
      chip.setAttribute("aria-busy", String(qbusy));
      if (quotaTipFor === chip) showQuotaTip(chip);   // 悬停中数据刷新：内容跟随
    }
    function restoreQuotaChip() {
      if (!quotaChipCache) return;
      if (quotaTipFor === quotaChipCache) hideQuotaTip();
      try { quotaChipCache.remove(); } catch (e) { }
      quotaChipCache = null;
      ariaLiveState.__zuQuotaLive = "";
      ariaLiveState.textContent = ariaLiveState.__zuGitLive || "";
    }

    /* ---------- v124 Git 状态 chip：始终挂在工具行左侧操作区 ----------
     * 样式移植 cc-pretty-statusline 的 git 段：⎇ 分支 ↑N ↓N (+插入行 -删除行 ?未跟踪文件)。
     * 数据：模块级 gitViewFor(scope.workspacePath)（主进程旁路查询推送）；本 pane 的 scope 为远端
     * （identity 非空）/ 未知 / 非仓库 / 无 git 时不挂载。稳定性同 v92：自有节点插在 React children
     * 之间（React 既不复用也不清理外来节点），位置由 render/heavy 双 reapply 兜回；内容签名幂等。 */
    function gitMount() {
      if (!cardCache) return null;
      function live(el) {
        if (!el.isConnected || !el.parentElement || inGhostSubtree(el)) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      var leading = cardCache.querySelectorAll('[data-composer-leading-content]');
      for (var i = 0; i < leading.length; i++) {
        var wrap = leading[i];
        if (!live(wrap)) continue;
        var buttons = wrap.querySelectorAll('[data-testid="v4-composer-cua-entry"]');
        for (var j = 0; j < buttons.length; j++) {
          if (live(buttons[j]) && buttons[j].parentElement === wrap) return { wrap: wrap, btn: buttons[j], after: buttons[j] };
        }
        var modes = wrap.querySelectorAll('[data-testid="chat-mode-select-trigger"]');
        for (var m = 0; m < modes.length; m++) {
          if (live(modes[m])) return { wrap: wrap, btn: modes[m], after: null };
        }
        return { wrap: wrap, btn: wrap, after: null };
      }
      var selectors = ['[data-testid="v4-composer-cua-entry"]', '[data-testid="chat-mode-select-trigger"]'];
      for (var k = 0; k < selectors.length; k++) {
        var candidates = cardCache.querySelectorAll(selectors[k]);
        for (var n = 0; n < candidates.length; n++) {
          var btn = candidates[n];
          if (!live(btn)) continue;
          var anchor = btn;
          while (anchor.parentElement && anchor.parentElement !== cardCache &&
                 !(anchor.parentElement.classList && anchor.parentElement.classList.contains("group/toolbar"))) anchor = anchor.parentElement;
          var parent = anchor.parentElement;
          if (parent && parent !== cardCache && parent.classList && parent.classList.contains("group/toolbar"))
            return { wrap: parent, btn: btn, after: anchor };
        }
      }
      return null;
    }
    var ZU_GIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>';
    /* v96 multi：多仓库聚合态图标 = lucide folder-git 官方 path 数据（描边宽对齐 ZU_GIT_ICON 的 1.5） */
    var ZU_GIT_MULTI_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="13" r="2"></circle>' +
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>' +
      '<path d="M14 13h3"></path><path d="M7 13h3"></path></svg>';
    function gitChipView() {   // null = 本 pane 当前不该显示 chip
      if (!state.show.git) return null;
      var scope = readPaneScope(wantedEl, pickedSid, pid);
      if (!scope || scope.identity || !scope.workspacePath) return null;
      var v = gitViewFor(scope.workspacePath);
      return v ? { path: scope.workspacePath, st: v.st, stale: v.stale } : null;
    }
    function gitChipHtml(view) {   // view={path, st, stale}：stale 是工作区级过期标志（勿与闭包 stale() 函数混淆）
      var st = view.st, stale = view.stale;
      if (st.kind === "multi") {   // v96 multi：仓库数 + ·分隔语义段（已知/上次前缀、!冲突、失败、过期）；文件条目汇总在 tooltip 不上 chip
        var agg = gitMultiAgg(st), parts = ['<span class="zu-git-name">' + agg.total + L("仓", " repos") + "</span>"];
        var prefix = agg.failed > 0 ? L("已知", "") : (agg.staleAny || stale) ? L("上次", "last ") : "";
        if (agg.changed > 0) parts.push('<span class="zu-git-dirty">' + prefix + agg.changed + L("改", " changed") + "</span>");   // 有改动仓库数；任一确认冲突时整段红（.zu-conflict）
        if (agg.conflict > 0) parts.push('<span class="zu-git-conflict">!' + agg.conflict + L("冲突", " conflicted") + "</span>");   // 确认冲突的仓库数
        if (agg.failed > 0) parts.push('<span class="zu-git-warn">' + agg.failed + L("失败", " failed") + "</span>");
        if (stale) parts.push('<span class="zu-git-warn">' + L("过期", "stale") + "</span>");   // 过期用文字提示，不降透明度
        return ZU_GIT_MULTI_ICON + parts.join('<span class="zu-git-sep">·</span>');
      }
      var name = st.detached ? "HEAD" : st.noCommits ? L("初始", "init") : String(st.branch || "HEAD");
      var shown = name.length > 18 ? name.slice(0, 16) + "…" : name;   // 全名进 tooltip
      var h = ZU_GIT_ICON + '<span class="zu-git-name">' + gitEsc(shown) + "</span>";
      var ab = (st.ahead > 0 ? "↑" + gitNum(st.ahead) : "") + (st.behind > 0 ? (st.ahead > 0 ? " " : "") + "↓" + gitNum(st.behind) : "");
      if (ab) h += '<span class="zu-git-ab">' + ab + "</span>";
      var nums = [];
      if (st.ins > 0) nums.push('<span class="zu-git-ins">+' + gitNum(st.ins) + "</span>");
      if (st.del > 0) nums.push('<span class="zu-git-del">-' + gitNum(st.del) + "</span>");
      var d = nums.join(" ") + (nums.length && st.untracked > 0 ? '<span class="zu-git-sep">·</span>' : "") + (st.untracked > 0 ? '<span class="zu-git-unt">?' + gitNum(st.untracked) + "</span>" : "");
      if (d) h += '<span class="zu-git-d">(' + d + ")</span>";   // 无任何改动时整段不出现
      if ((st.conflicts | 0) > 0) h += ' <span class="zu-git-conflict">!' + gitNum(st.conflicts) + L("冲突", " conflicted") + "</span>";
      if (st.op) h += ' <span class="zu-git-op">' + gitEsc(gitOpLabel(st.op)) + "</span>";
      if (stale) h += ' <span class="zu-git-warn">' + L("过期", "stale") + "</span>";
      return h;
    }
    function gitChipAria(st, stale) {
      if (st.kind === "multi") {
        var a = gitMultiAgg(st);
        var ms = L("Git " + a.total + " 个仓库", "Git " + a.total + " repos");
        if (a.changed > 0 || a.failed > 0) ms += L("，" + (a.failed > 0 ? "已知 " : "") + a.changed + " 个有改动", ", " + a.changed + " with changes");
        if (a.conflict > 0) ms += L("，" + a.conflict + " 个仓库冲突", ", " + a.conflict + " repos conflicted");
        if (a.op > 0) ms += L("，" + a.op + " 个操作中", ", " + a.op + " mid-operation");
        if (a.failed > 0) ms += L("，" + a.failed + " 个查询失败", ", " + a.failed + " failed");
        if (stale) ms += L("，数据已过期", ", data stale");
        return ms;
      }
      var s = L("Git 分支 ", "Git branch ") + (st.detached ? "HEAD" : st.noCommits ? L("初始（尚无首次提交）", "init (no initial commit yet)") : st.branch);
      if (st.ahead > 0) s += L("，领先 ", ", ahead ") + st.ahead;
      if (st.behind > 0) s += L("，落后 ", ", behind ") + st.behind;
      if (st.ins > 0 || st.del > 0) s += L("，改动 +", ", changes +") + (st.ins | 0) + " -" + (st.del | 0);
      if (st.untracked > 0) s += L("，未跟踪 ", ", untracked ") + st.untracked;
      if ((st.conflicts | 0) > 0) s += L("，! " + st.conflicts + " 个冲突文件", ", ! " + st.conflicts + " conflicted files");
      if (st.op) s += L("，进行中操作：", ", git operation: ") + gitOpLabel(st.op);
      if (stale) s += L("，数据已过期", ", data stale");
      return s;
    }
    function onGitEnter() { showGitTip(this); }
    function onGitClick(e) {
      e.preventDefault();
      e.stopPropagation();
      if (gitRefreshRequestId) return;
      var scope = readPaneScope(wantedEl, pickedSid, pid);
      var targetPath = scope ? scope.workspacePath : "";
      if (!targetPath) return;
      this.classList.add("zu-gbusy");
      this.setAttribute("aria-busy", "true");
      gitRefreshPath = targetPath;
      announceGitRefresh();
      var requestId = "";
      var refreshScopeStamp = JSON.stringify({ sid: pickedSid || "", identity: scope.identity, workspacePath: scope.workspacePath });
      var requested = askGitRefresh(true, function (result) {
        if (inactive() || gitRefreshRequestId !== requestId) return;
        var currentScope = readPaneScope(wantedEl, pickedSid, pid);
        var currentScopeStamp = JSON.stringify(currentScope && {
          sid: currentScope.sid, identity: currentScope.identity, workspacePath: currentScope.workspacePath,
        });
        if (currentScopeStamp !== refreshScopeStamp) { cancelGitRefresh(); return; }
        gitRefreshRequestId = "";
        gitRefreshPath = "";
        if (gitChipCache) { gitChipCache.classList.remove("zu-gbusy"); gitChipCache.setAttribute("aria-busy", "false"); }
        enhanceGitChip();
        var view = gitChipView();
        var summary = view ? gitChipAria(view.st, view.stale) : L("当前目录没有 Git 状态", "No Git status for this directory");
        var text = result && result.ok
          ? L("Git 状态已更新：", "Git status updated: ") + summary
          : L("Git 状态查询失败：", "Git status query failed: ") + summary;
        ariaLiveState.__zuGitLive = text;
        ariaLiveState.textContent = text;
      });
      if (!requested) {
        gitRefreshRequestId = "";
        gitRefreshPath = "";
        if (gitChipCache) { gitChipCache.classList.remove("zu-gbusy"); gitChipCache.setAttribute("aria-busy", "false"); }
        var currentView = gitChipView();
        var currentStatus = currentView ? gitChipAria(currentView.st, currentView.stale) : "";
        ariaLiveState.__zuGitLive = currentStatus;
        ariaLiveState.textContent = currentStatus || ariaLiveState.__zuQuotaLive || "";
        enhanceGitChip();
      } else {
        requestId = (window.__zusagePluginRequests[window.__zusagePluginRequests.length - 1] || {}).requestId || "";
        gitRefreshRequestId = requestId;
        if (!requestId) {
          gitRefreshPath = "";
          if (gitChipCache) { gitChipCache.classList.remove("zu-gbusy"); gitChipCache.setAttribute("aria-busy", "false"); }
        }
      }
    }
    function announceGitRefresh() {
      if (!ariaLiveState || !gitRefreshPath) return;
      var busyText = L("Git 状态查询中", "Checking Git status");
      if (ariaLiveState.__zuGitLive !== busyText) {
        ariaLiveState.__zuGitLive = busyText;
        ariaLiveState.textContent = busyText;
      }
    }
    function cancelGitRefresh() {
      if (!gitRefreshRequestId) return;
      gitRefreshRequestId = "";
      gitRefreshPath = "";
      if (gitChipCache) {
        gitChipCache.classList.remove("zu-gbusy");
        gitChipCache.setAttribute("aria-busy", "false");
      }
      ariaLiveState.__zuGitLive = "";
      ariaLiveState.textContent = ariaLiveState.__zuQuotaLive || "";
    }
    function gitChipCompact(btn, chip, html, mount) {
      if (btn.getAttribute("data-composer-compact") === "true") return true;
      if (!chip.classList.contains("zu-compact")) return false;
      var row = cardCache ? toolbarRowOf(cardCache) : null, probe = null;
      try {
        if (!row || !(row.clientWidth > 0)) return false;
        var content = mount && mount.wrap.hasAttribute("data-composer-leading-content") ? mount.wrap : row.querySelector("[data-composer-leading-content]");
        var available = content && content.parentElement && content.parentElement.hasAttribute("data-composer-leading-actions") ? content.parentElement : row.querySelector("[data-composer-leading-actions]");
        var trailing = row.querySelector("[data-composer-trailing-actions]");
        var hasLeading = content && available && content.hasAttribute("data-composer-leading-content") && available.hasAttribute("data-composer-leading-actions");
        var gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        var used = 0, room = row.clientWidth;
        if (hasLeading) {
          used = content.getBoundingClientRect().width;
          room = Math.min(available.getBoundingClientRect().width, row.getBoundingClientRect().width - (trailing && trailing.hasAttribute("data-composer-trailing-actions") ? trailing.getBoundingClientRect().width + gap : 0));
        } else {
          for (var i = 0; i < row.children.length; i++) used += row.children[i].getBoundingClientRect().width;
          used += Math.max(0, row.children.length - 1) * gap;
        }
        // 宿主的测量副本保留 zu-compact；只看当前余量会把收起的分支名误当作永久空闲。
        probe = chip.cloneNode(true);
        probe.innerHTML = html;
        probe.classList.remove("zu-compact");
        probe.setAttribute("aria-hidden", "true");
        probe.inert = true;
        probe.style.position = "fixed";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.width = "max-content";
        probe.style.maxWidth = "none";
        document.body.appendChild(probe);
        var fullWidth = probe.getBoundingClientRect().width;
        var currentWidth = chip.getBoundingClientRect().width;
        if (!(fullWidth > 0) || !(currentWidth > 0) || !(room > 0) || !(used > 0)) return false;
        return used + Math.max(0, fullWidth - currentWidth) + 32 > room;
      } catch (e) { return false; }
      finally { if (probe) probe.remove(); }
    }
    function enhanceGitChip() {
      if (inactive()) { restoreGitChip(); return; }
      var scope = readPaneScope(wantedEl, pickedSid, pid);
      var view = gitChipView();
      if (!view) { restoreGitChip(); return; }
      var mount = null;
      try { mount = gitMount(); } catch (e) { }
      if (!mount) { restoreGitChip(); return; }
      var btn = mount.btn, wrap = mount.wrap;
      var chip = gitChipCache;
      if (!chip || !chip.isConnected) {
        if (gitTipFor === chip) hideGitTip();
        chip = null;
        for (var i = 0; i < wrap.children.length; i++) {   // 复用热更/重建遗留的同类节点，避免双 chip
          if (wrap.children[i].classList && wrap.children[i].classList.contains("zu-git")) { chip = wrap.children[i]; break; }
        }
        if (!chip) {
          chip = document.createElement("span");
          chip.className = "zu-git";
          chip.setAttribute("role", "button");
          chip.setAttribute("aria-keyshortcuts", "Enter Space");
          chip.tabIndex = 0;
          chip.addEventListener("mouseenter", onGitEnter);
          chip.addEventListener("mouseleave", hideGitTipSoon);
          chip.addEventListener("focus", onGitEnter);
          chip.addEventListener("blur", hideGitTip);
          chip.addEventListener("keydown", onRefreshKeydown);
          chip.addEventListener("keyup", onRefreshKeyup);
          chip.addEventListener("click", onGitClick);
        }
        gitChipCache = chip;
      }
      /* 位置兜回：电脑操作后方，或左侧操作区末尾。容忍速率 chip 紧贴锚位（v147：精简模式
       * 速率在 git 左侧 = [锚][速率][git]，速率让位后 git 自然回贴锚位），否则两 chip 逐拍互相拉锯 */
      var slotNode = mount.after ? mount.after.nextSibling : null;
      var mis;
      if (!chip.isConnected) mis = true;   // 首挂必须插入：速率 chip 占锚位时先落其后再由速率兜回收敛 [锚][速率][git]（容忍规则只用于已挂载的位置保持，否则精简下 git chip 永不出现）
      else if (mount.after) mis = slotNode !== chip && !(tpsChipCache && slotNode === tpsChipCache);
      else mis = wrap.lastElementChild !== chip;
      if (mis) wrap.insertBefore(chip, slotNode);
      var gitLiveText = gitChipAria(view.st, view.stale);
      if (ariaLiveState.__zuGitLive !== gitLiveText) {
        ariaLiveState.__zuGitLive = gitLiveText;
        ariaLiveState.textContent = ariaLiveState.__zuGitLive || ariaLiveState.__zuQuotaLive || "";
      }
      syncCtxLite(chip, bar.classList.contains("zu-light"));
      chip.__zuGit = view;
      var html = gitChipHtml(view);
      var compact = gitChipCompact(btn, chip, html, mount);
      var mAgg = view.st.kind === "multi" ? gitMultiAgg(view.st) : null;
      var cls = "zu-git" + (compact ? " zu-compact" : "") + (view.st.kind === "multi" ? " zu-git-multi" : "") + (mAgg && mAgg.conflict > 0 ? " zu-conflict" : "");   // v96：形态类（紧凑态收起份数与聚合计数段）+ 确认冲突 → 冲突段转红（类进签名保持幂等）；过期走文字徽章不降透明度
      var sig = cls + "|" + html + "|" + state.lang;
      var busy = chip.classList.contains("zu-gbusy");
      if (chip.__zuSig !== sig) {   // 幂等：内容不变时不重建 chip
        chip.__zuSig = sig;
        chip.className = cls + (busy ? " zu-gbusy" : "");
        chip.setAttribute("aria-label", gitChipAria(view.st, view.stale));
        chip.innerHTML = html;
      }
      chip.classList.toggle("zu-gbusy", busy);
      chip.setAttribute("aria-busy", String(busy));
      if (gitTipFor === chip) showGitTip(chip);   // 悬停中数据刷新：内容跟随
    }
    function restoreGitChip() {
      gitRefreshPath = "";
      if (!gitChipCache) {
        ariaLiveState.__zuGitLive = "";
        ariaLiveState.textContent = ariaLiveState.__zuQuotaLive || "";
        return;
      }
      if (gitTipFor === gitChipCache) hideGitTip();
      try { gitChipCache.remove(); } catch (e) { }
      gitChipCache = null;
      ariaLiveState.__zuGitLive = "";
      ariaLiveState.textContent = ariaLiveState.__zuQuotaLive || "";
    }

    /* ---------- v105 压缩上下文：「上下文容量」弹层内、命中率行下方的胶囊按钮 ----------
     * 弹层（hover-card-content）关即卸载（Radix 无 forceMount），每次打开全新挂载——注入
     * 节点随之销毁，靠 body MutationObserver（即时）+ heavy 对账点（600ms 兜底）双触发重注
     * 入；以 DOM 存在性幂等，多实例并发安全。打开期间 React 只原地 patch，不会删除外来
     * 兄弟节点，最多相对移位（新 border-t 段出现时），同步时位置兜回（同 quota chip 3765 套路）。
     * 面板判别双指纹：!w-80（contextPanelWidthClass，全仓库唯一 important 宽）+ 内含 ui
     * Progress；插入锚=ContextContentBody（div.space-y-3）内「剩余额度」border-t 段之前
     * （命中率行在 <78% 时条件隐藏，锚定 border-t 段不受影响），缺则容器尾（仍是命中率行下）。
     * 确认后发送 /compact：优先 fiber 上原生残留的 onSendCompressionCommand（SessionPane
     * 压缩入口，最终 dispatchCommand("compact")，与手敲 /compact 同链、不动草稿、自带 toast）；
     * 缺失回落官方 E2E 输入桥（生产客户端无条件挂载）__zcodeLexicalInputE2E.setText +
     * 发送键。Lexical 的 contenteditable 直写不进 EditorState，该路径禁用；兜底通道会清写
     * 输入框，草稿非空一律拒绝。pane 归属：按几何就近的可见触发按钮（分栏各拿各的 fiber）。 */
    var ZU_HC_SEL = '[data-slot="hover-card-content"]';
    var compactDlg = null, compactDlgKey = null, compactAnchor = null, compactFn = null;
    var acFlashTimer = 0;   // v189：「调整」链接高亮阈值行的 3 秒计时器（dispose 清理）
    function nearestByRect(anchor, sel) {   // 可见元素中矩形中心离 anchor 最近者；隐藏 pane 不参与
      var list = [], r0 = null;
      try {
        list = document.querySelectorAll(sel);
        r0 = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
      } catch (e) { return null; }
      var best = null, bd = Infinity;
      var cx = r0 ? r0.left + r0.width / 2 : 0, cy = r0 ? r0.top + r0.height / 2 : 0;
      for (var i = 0; i < list.length; i++) {
        var r = null;
        try { r = list[i].getBoundingClientRect(); } catch (e) { }
        if (!r || r.width <= 0 || r.height <= 0) continue;
        var dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
        var d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = list[i]; }
      }
      return best;
    }
    function fiberPropFrom(el, prop) {   // 沿 __reactFiber$ 向上找 memoizedProps（限深 60 层）
      try {
        var ks = Object.keys(el), fk = "";
        for (var i = 0; i < ks.length; i++) {
          if (ks[i].indexOf("__reactFiber$") === 0) { fk = ks[i]; break; }
        }
        if (!fk) return null;
        var f = el[fk], n = 0;
        while (f && n++ < 60) {
          if (f.memoizedProps && typeof f.memoizedProps[prop] === "function") return f.memoizedProps[prop];
          f = f.return;
        }
      } catch (e) { }
      return null;
    }
    /* v179 阈值行文案：仅引擎补丁生效时返回文本（空串=不渲染）。阈值百分比 v194 起
       为总窗口口径（引擎 hook 以 eff+21K 近似还原标称窗口并钳在有效窗口内），设置值、
       本行百分比与原生按钮三者同口径；解析不到总量时只给 token 绝对值；token 数
       v191 起走 fmt()（万/亿/K·M·B 与状态条、tooltip 同一转换链，含强制 KMB 开关）。 */
    function acInfoText(body) {
      var ep = state.enginePatch;
      if (!ep || ep.state !== "applied") return "";
      var mc = acModeOf(ep.config);
      var cw = 0;
      try {
        var trig = nearestByRect(body, ZU_CTX_TRIGGER);
        var label = trig ? String(trig.getAttribute("aria-label") || "") : "";
        var m = label.match(/([\d,，]+)\s*\/\s*总量\s*([\d,，]+)/) || label.match(/([\d,]+)\s+of\s+([\d,]+)/i);
        if (m) cw = parseInt((m[2] || "").replace(/[,,]/g, ""), 10);
      } catch (e) { }
      if (mc.mode === "default") {
        /* 引擎默认阈值 = 窗口 − 21K 预留 − 13K 缓冲（policy.ts 常量）：窗口已知按现算，未知不写死比例 */
        if (cw > 34000) return L("自动压缩：跟随引擎默认 ~" + Math.round((cw - 34000) / cw * 100) + "%", "Auto-compact: engine default, ~" + Math.round((cw - 34000) / cw * 100) + "%");
        return L("自动压缩：跟随引擎默认", "Auto-compact: engine default");
      }
      if (mc.mode === "disabled") return L("自动压缩：已禁用（超窗兜底仍在）", "Auto-compact: disabled (overflow fallback intact)");
      var th = acTargetTokens(mc, cw || 0);
      if (th == null) return L("自动压缩：自定义阈值", "Auto-compact: custom threshold");
      if (th <= 0) return L("自动压缩：自定义阈值（当前窗口未知，无法换算百分比）", "Auto-compact: custom threshold (window size unknown; no percentage)");
      var v = Math.round(th);
      if (cw > 0) return L("自动压缩 ~" + Math.round(v / cw * 100) + "%（" + fmt(v) + " token）", "Auto-compact at ~" + Math.round(v / cw * 100) + "% (" + fmt(v) + " tokens)");
      return L("自动压缩阈值 " + fmt(v) + " token", "Auto-compact threshold " + fmt(v) + " tokens");
    }
    function syncCompactBtn() {
      if (inactive()) return;
      var hcs = [];
      try { hcs = document.querySelectorAll(ZU_HC_SEL); } catch (e) { return; }
      for (var i = 0; i < hcs.length; i++) {
        var body = null, anchor = null;
        try {
          if (!hcs[i].classList.contains("!w-80")) continue;
          if (!hcs[i].querySelector('[data-slot="progress"]')) continue;
          body = hcs[i].querySelector("div.space-y-3");
        } catch (e) { continue; }
        if (!body) continue;
        try {
          for (var j = 0; j < body.children.length; j++) {
            /* 「剩余额度」段=border-t+pt-2（CodingPlanContextUsage/StartPlanContextBalance 的
             * separated 分支）；命中率行在 breakdown 存在时也带 border-t 但是 pt-3，须双类名
             * 判别，否则按钮会插到命中率行上方。 */
            var cls2 = body.children[j].classList;
            if (cls2 && cls2.contains("border-t") && cls2.contains("pt-2")) { anchor = body.children[j]; break; }
          }
        } catch (e) { }
        var exist = null, acInfo = null, acHint = null;
        for (var k = 0; k < body.children.length; k++) {
          var cls3 = body.children[k].classList;
          if (!cls3) continue;
          if (cls3.contains("zu-compact-btn")) exist = body.children[k];
          else if (cls3.contains("zu-ac-info")) acInfo = body.children[k];
          else if (cls3.contains("zu-ac-hint")) acHint = body.children[k];
        }
        /* v200 压缩按钮开关（issue #174）：关闭=摘除已注入按钮（弹层还原原生形态，阈值
         * 行顶到按钮原位）；开启=幂等重挂 + 位置兜回（紧贴「剩余额度」段上方，无则容器尾） */
        if (!state.ctxCpt) {
          if (exist) exist.remove();
          exist = null;
        } else if (exist) {   // 幂等 + 位置兜回：紧贴「剩余额度」段上方（无则容器尾）
          var misplaced = anchor ? exist.nextElementSibling !== anchor : body.lastElementChild !== exist;
          if (misplaced) body.insertBefore(exist, anchor);
        } else {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "zu-compact-btn";
          b.textContent = L("压缩上下文", "Compact context");
          b.addEventListener("click", onCompactClick);
          body.insertBefore(b, anchor);
          exist = b;   // 首挂即回填：阈值行的位置钉靠它，不依赖 querySelector 兜底
        }
        var acRef = exist || anchor;   // v200：按钮在=阈值行钉其上方；按钮关=顶到「剩余额度」段上方
        /* v179 阈值行 → v189 移到压缩按钮上方：文本 + 下划线「调整」链接（点击打开
         * ⚙ 并高亮阈值数值行 3 秒）；v195 下方小字说明行（口径+后果，同生命周期）。
         * 配置变化原地改字（幂等），补丁未生效即摘除。
         * 文本/链接各用 span 按 class 定位更新——整行 textContent 覆盖会抹掉链接。 */
        var infoText = acInfoText(body);
        if (!infoText) { if (acInfo) acInfo.remove(); if (acHint) acHint.remove(); }
        else {
          if (!acInfo) {
            acInfo = document.createElement("div");
            acInfo.className = "zu-ac-info";
            var acText = document.createElement("span");
            acText.className = "zu-ac-text";
            var acLink = document.createElement("span");
            acLink.className = "zu-ac-link";
            acLink.textContent = L("调整", "Adjust");
            /* v198：宿主疑似在 mousedown 即关 hover 卡（click 到来时链接已被摘/穿透，
             * v196/197 实机诊断 acOpen 恒空），改 pointerdown 抢在关闭前响应；
             * click 兜底保留（合成事件与异常路径），面板打开幂等不惧双触发。 */
            acLink.addEventListener("pointerdown", function (e) {
              e.stopPropagation();
              e.preventDefault();
              openAcThresholdSettings();
            });
            acLink.addEventListener("click", function (e) {
              e.stopPropagation();
              e.preventDefault();
              openAcThresholdSettings();
            });
            acInfo.appendChild(acText);
            acInfo.appendChild(acLink);
          }
          var acTextEl = null;
          for (var k2 = 0; k2 < acInfo.children.length; k2++) {
            if (acInfo.children[k2].classList && acInfo.children[k2].classList.contains("zu-ac-text")) { acTextEl = acInfo.children[k2]; break; }
          }
          if (acTextEl && acTextEl.textContent !== infoText) acTextEl.textContent = infoText;
          if (acInfo.nextElementSibling !== acRef) body.insertBefore(acInfo, acRef);   // 钉在压缩按钮上方（按钮关闭时顶到其原位）
          if (!acInfo.__zuRowDelegated) {
            acInfo.__zuRowDelegated = true;
            acInfo.addEventListener("click", function (e) {
              var t = e.target;
              if (t && t.classList && t.classList.contains("zu-ac-link")) openAcThresholdSettings();
            });
          }
          /* v195 新手说明：口径（按窗口总量、与顶部百分比同口径）与后果（自动压缩腾空间），
           * 小字弱化，随阈值行同生命周期；钉在其下、按钮之上。 */
          var hintText = L("按窗口总量计算（与顶部百分比同口径）；走到该比例时，客户端会自动压缩较早的对话内容以腾出空间。", "Measured against the full window (same basis as the percentage above); when reached, earlier conversation is compacted automatically to free up space.");
          if (!acHint) {
            acHint = document.createElement("div");
            acHint.className = "zu-ac-hint";
          }
          if (acHint.textContent !== hintText) acHint.textContent = hintText;
          if (acHint.previousElementSibling !== acInfo || acHint.nextElementSibling !== acRef) body.insertBefore(acHint, acRef);
        }
      }
    }
    /* v189：hover 面板「调整」链接 → 打开 ⚙ 面板并高亮「压缩上下文阈值数值」行 3 秒。
     * 打开复用 gear 点击的完整官方路径（焦点/互斥/高度重测）；分区切换复用导航点击
     * 的关键步骤；高亮计时器实例级归属（dispose 清理）。 */
    function openAcThresholdSettings() {
      if (instanceDisposed) return;
      if (!panel.classList.contains("open")) gear.click();
      if (activeSettingsSec() !== "general") {
        state.settingsSec = "general";
        persist();
        panel.querySelectorAll(".zu-settings-section[data-sec]").forEach(function (s) {
          s.hidden = s.getAttribute("data-sec") !== "general";
        });
        panel.querySelectorAll(".zu-navitem").forEach(function (b) {
          if (b.getAttribute("data-sec") === "general") b.setAttribute("aria-current", "page");
          else b.removeAttribute("aria-current");
        });
        var navBody = panel.querySelector(".zu-settings-body");
        if (navBody) navBody.scrollTop = 0;
        syncSettingsScroll();
      }
      var row = panel.querySelector(".zu-ac-value");
      row = row && row.closest ? row.closest("label") : null;
      if (!row) return;
      try { row.scrollIntoView({ block: "nearest" }); } catch (e) { }
      row.classList.add("zu-ac-flash");
      clearTimeout(acFlashTimer);
      acFlashTimer = setTimeout(function () {
        acFlashTimer = 0;
        try { row.classList.remove("zu-ac-flash"); } catch (e) { }
      }, 3000);
    }
    function closeCompactDlg() {
      if (compactDlgKey) {
        try { document.removeEventListener("keydown", compactDlgKey, true); } catch (e) { }
        compactDlgKey = null;
      }
      if (compactDlg) { try { compactDlg.remove(); } catch (e) { } compactDlg = null; }
      compactAnchor = null; compactFn = null;
    }
    function openCompactDlg(anchorBtn) {
      closeCompactDlg();
      compactAnchor = anchorBtn || null;
      /* fiber 提交函数只在打开瞬间解析（此刻弹层必存活、锚点几何可信）；确认时弹层可能
       * 已被 Radix 卸载（指针移入弹框），届时重解析会退化为「离视口左上角最近」，
       * 多分栏窗口会把 /compact 发进错误 pane 的会话（v110 修复）。 */
      var trig = null, label = "", fn = null;
      try {
        trig = nearestByRect(compactAnchor, ZU_CTX_TRIGGER);
        label = trig ? String(trig.getAttribute("aria-label") || "") : "";
        fn = trig ? fiberPropFrom(trig, "onSendCompressionCommand") : null;
      } catch (e) { }
      compactFn = fn || null;
      var m = label.match(/([\d,，]+)\s*\/\s*总量\s*([\d,，]+)/) || label.match(/([\d,]+)\s+of\s+([\d,]+)/i);
      var dlg = document.createElement("div");
      dlg.className = "zu-compact-dlg";
      var card = document.createElement("div");
      card.className = "zu-compact-card";
      var title = document.createElement("div");
      title.className = "zu-compact-title";
      title.textContent = L("压缩上下文", "Compact context");
      var desc = document.createElement("div");
      desc.className = "zu-compact-desc";
      if (m) {
        var b1 = document.createElement("b");
        b1.textContent = L("当前已用 " + m[1] + " / 总量 " + m[2], "Used " + m[1] + " of " + m[2]);
        desc.appendChild(b1);
        desc.appendChild(document.createTextNode(L("。将把会话历史总结压缩以释放上下文窗口，压缩后上下文占比会回落。", ". The conversation history will be summarized to free context window space; usage drops afterwards.")));
      } else {
        desc.textContent = L("将把会话历史总结压缩以释放上下文窗口，压缩后上下文占比会回落。", "The conversation history will be summarized to free context window space; usage drops afterwards.");
      }
      var hint = document.createElement("div");
      hint.className = "zu-compact-hint";
      hint.textContent = L("压缩通常需要 2-4 分钟且没有进度反馈，期间请勿发送新消息或点停止——那会取消压缩。", "Compaction usually takes 2–4 minutes with no progress indicator. Don't send new messages or stop during it — that cancels it.");
      var err = document.createElement("div");
      err.className = "zu-compact-err";
      var foot = document.createElement("div");
      foot.className = "zu-compact-foot";
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "zu-compact-cancel";
      cancel.textContent = L("取消", "Cancel");
      var ok = document.createElement("button");
      ok.type = "button";
      ok.className = "zu-compact-ok";
      ok.textContent = L("压缩", "Compact");
      cancel.addEventListener("click", closeCompactDlg);
      dlg.addEventListener("mousedown", function (e) {
        if (e.target === dlg) closeCompactDlg();   // 点遮罩关闭（卡片内点击不关）
      });
      ok.addEventListener("click", function () {
        if (ok.disabled) return;
        ok.disabled = true;
        var fail = compactSend(compactAnchor || ok);
        if (fail) {   // 失败：弹框保留并显示中性错误文案，不静默不关闭
          ok.disabled = false;
          err.textContent = fail;
          err.classList.add("on");
          return;
        }
        closeCompactDlg();
      });
      compactDlgKey = function (e) {
        if (!compactDlg) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeCompactDlg();
        } else if (e.key === "Enter" && !ok.disabled) {
          var f = null;
          try { f = document.activeElement; } catch (e2) { }
          if (f && dlg.contains && !dlg.contains(f)) return;   // 焦点已逸出弹框（无焦点陷阱）：不劫持宿主 Enter
          e.preventDefault();
          e.stopPropagation();
          ok.click();
        }
      };
      document.addEventListener("keydown", compactDlgKey, true);   // 捕获先行，拦下宿主对 Esc/Enter 的处理
      foot.appendChild(cancel);
      foot.appendChild(ok);
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(hint);
      card.appendChild(err);
      card.appendChild(foot);
      dlg.appendChild(card);
      document.body.appendChild(dlg);
      compactDlg = dlg;
      try { ok.focus(); } catch (e) { }
    }
    function compactSend(anchorEl) {   // 返回 "" = 已提交；否则错误文案
      /* 主通道（v109 用户指定「直接调发送会话的接口」；v110 改在打开瞬间解析缓存）：
       * fiber 上原生残留的 onSendCompressionCommand——SessionPane 自己的程序化压缩入口，
       * 直接 dispatchCommand("compact") 命令信封，不碰输入框/发送键，流式中也交给引擎
       * 排队。摘要请求非流式（DB 历史 72s-9.6min、典型 2-4 分钟），hint 据此措辞。
       * 兜底：字面 "/compact" 输入提交（E2E 桥 setText+发送键）——流式/发送键/草稿
       * 三重门控全部前置到 setText 之前（拒绝不留残迹），仅当 fiber 通道缺失时使用。 */
      if (compactFn) {
        try { compactFn("/compact"); return ""; } catch (e) { FATAL.cptErr = String((e && e.stack) || e); }
      }
      var input = nearestByRect(anchorEl, '[data-testid="v4-composer-input"]');
      var api = null;
      try { api = input ? input.__zcodeLexicalInputE2E : null; } catch (e) { }
      if (input && api && input.getAttribute("data-e2e-lexical-bridge") === "ready") {
        try {
          if (nearestByRect(anchorEl, '[data-testid="v4-stop"]')) return L("正在生成回复，请等待完成后再压缩", "A reply is being generated; wait for it to finish before compacting");
          var send = nearestByRect(anchorEl, '[data-testid="v4-composer-send"]');
          if (!send || send.disabled) return L("发送键当前不可用（可能正在生成回复）", "Send button is unavailable right now (a reply may be running)");
          var draft = "";
          try { draft = String(api.getText() || ""); } catch (e) { }
          if (draft.replace(/\s+/g, "")) return L("输入框有未发送草稿，请先发送或清空后再压缩", "The composer has an unsent draft; send or clear it before compacting");
          api.setText("/compact");
          send.click();
          return "";
        } catch (e) { FATAL.cptErr = String((e && e.stack) || e); return L("发送失败，请重试", "Send failed; please try again"); }
      }
      return L("未找到可用的提交通道（需 ZCode 桌面端）", "No available submit channel (ZCode desktop required)");
    }
    function onCompactClick(e) {
      if (inactive()) return;   // 停用实例的残留按钮（新代际清扫前的窗口期）无声失效
      e.preventDefault();
      e.stopPropagation();   // 弹层内点击不外泄（Radix/宿主不响应这次 click）
      openCompactDlg(e.currentTarget);
    }

    /* ---------- v80 in-card 挂载：条挂输入卡片内部、group/toolbar 工具行之后自占一行 ----------
     * 宿主 ChatPromptEditor 的工具行是卡片（flex-col gap-3）的最后一个子块；条作为其兄弟
     * 节点插在后面，卡片纯自适应高度自然长高（12px 间距 + 条高），与对话框融为一体。
     * 工具行 Tailwind 类名含 : / [ ] 特殊字符，querySelector 转义易碎 → 按直接子节点
     * className 子串匹配（同 zuDetAnchor 套路）。找不到工具行 = below-card 兜底形态。 */
    function toolbarRowOf(card) {
      try {
        var kids = card.children;
        for (var i = kids.length - 1; i >= 0; i--) {
          if (String(kids[i].className || "").indexOf("group/toolbar") >= 0) return kids[i];
        }
      } catch (e) { }
      return null;
    }
    function mountInCard() {
      var row = cardCache ? toolbarRowOf(cardCache) : null;
      if (!row) return false;
      try {
        if (bar.parentElement !== cardCache) {
          var ref = row.nextSibling;
          if (ref && ref.parentElement === cardCache) cardCache.insertBefore(bar, ref);
          else cardCache.appendChild(bar);
        }
        if (!bar.classList.contains("zu-in")) {
          bar.classList.add("zu-in");
          /* .zu-in 管不住内联声明：摘掉兜底形态写入的悬浮样式与锁宽 */
          bar.style.position = ""; bar.style.zIndex = "";
          bar.style.left = ""; bar.style.top = ""; bar.style.minWidth = ""; bar.style.maxWidth = "";
          lastPos = [-1, -1];
        }
        return true;
      } catch (e) { return false; }
    }
    function mountBelowCard() {   // 兜底还原：无工具行（宿主改版/异形布局）时回到旧悬浮形态
      if (!bar.classList.contains("zu-in") && bar.parentElement === document.body) return;
      bar.classList.remove("zu-in");
      bar.style.position = "fixed"; bar.style.zIndex = "50";
      document.body.appendChild(bar);
      lastPos = [-1, -1];
    }

    /* ---------- 定位：重活低频（找输入框/找卡片），逐帧只做矩形跟随 ---------- */
    var composer = null, cardCache = null, everMounted = false, lastMountDiagAt = 0;
    var curDisplay = "none", lastPos = [-1, -1], hideSince = 0;
    /* v80：true=条挂在输入卡片内部（group/toolbar 工具行之后）；false=旧 below-card 悬浮兜底 */
    var cardMode = false;
    var pillSurface = null, pillObserver = null, pillSyncFrame = 0, pillTransitionTimer = 0;
    var pillTransitions = new Map(), pillParent = null, pillAncestors = [], pillWasHighspeed = false;
    var pillProps = [
      ["backgroundColor", "--zu-pill-bg"],
      ["borderTopWidth", "--zu-pill-border-width"],
      ["borderTopStyle", "--zu-pill-border-style"],
      ["borderTopColor", "--zu-pill-border-color"],
      ["borderRadius", "--zu-pill-radius"]
    ];
    function findPillSurface() {
      if (!composer) return null;
      try {
        var highspeed = composer.closest('[data-highspeed-composer="true"],.highspeed-composer-surface');
        if (highspeed) return highspeed;
      } catch (e) { }
      return cardCache;
    }
    function syncPillSurface() {
      if (inactive() || state.theme !== "pill" || !pillSurface || !pillSurface.isConnected || document.hidden) return;
      try {
        var cs = getComputedStyle(pillSurface);
        for (var i = 0; i < pillProps.length; i++) {
          var value = cs[pillProps[i][0]];
          if (value && bar.style.getPropertyValue(pillProps[i][1]) !== value) bar.style.setProperty(pillProps[i][1], value);
        }
      } catch (e) { }
    }
    function queuePillSurface() {
      if (inactive() || state.theme !== "pill" || pillSyncFrame) return;
      pillSyncFrame = requestAnimationFrame(function () {
        pillSyncFrame = 0;
        prunePillTransitions();
        bindPillSurface();
        ensureCardPad();
        syncPillSurface();
      });
    }
    function prunePillTransitions() {
      pillTransitions.forEach(function (keys, target) {
        if (!composer || !target.isConnected || !target.contains(composer)) pillTransitions.delete(target);
      });
      if (!pillTransitions.size) {
        clearInterval(pillTransitionTimer);
        pillTransitionTimer = 0;
      }
    }
    function onPillTransition(e) {
      if (state.theme !== "pill" || !e.target || !composer) return;
      var key = (e.propertyName || e.animationName || "") + (e.type.indexOf("animation") === 0 ? ":a" : ":t");
      var keys = pillTransitions.get(e.target);
      if (e.type === "transitionrun" || e.type === "animationstart") {
        if (!e.target.contains(composer)) return;
        if (!keys) { keys = new Set(); pillTransitions.set(e.target, keys); }
        keys.add(key);
      } else if (keys) {
        keys.delete(key);
        if (!keys.size) pillTransitions.delete(e.target);
      }
      queuePillSurface();
      if (pillTransitions.size) {
        if (!pillTransitionTimer) pillTransitionTimer = setInterval(queuePillSurface, 80);
      } else {
        clearInterval(pillTransitionTimer);
        pillTransitionTimer = 0;
      }
    }
    function bindPillTransitions() {
      ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"].forEach(function (type) {
        document.addEventListener(type, onPillTransition, true);
      });
    }
    function unbindPillTransitions() {
      ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"].forEach(function (type) {
        document.removeEventListener(type, onPillTransition, true);
      });
      clearInterval(pillTransitionTimer);
      pillTransitionTimer = 0;
      pillTransitions.clear();
    }
    function clearPillSurface() {
      if (pillObserver) pillObserver.disconnect();
      pillObserver = null;
      if (pillSyncFrame) cancelAnimationFrame(pillSyncFrame);
      pillSyncFrame = 0;
      unbindPillTransitions();
      if (pillSurface) {
        ["pointerenter", "pointerleave", "focusin", "focusout"].forEach(function (type) {
          pillSurface.removeEventListener(type, queuePillSurface);
        });
      }
      pillSurface = null;
      pillLayoutAnchor = null;
      pillParent = null;
      pillAncestors = [];
      pillWasHighspeed = false;
      if (bar.style.removeProperty) pillProps.forEach(function (pair) { bar.style.removeProperty(pair[1]); });
    }
    function observePillAncestors() {
      if (!pillObserver || !pillSurface) return;
      var ancestors = [];
      for (var p = pillSurface.parentElement; p && p !== document.body; p = p.parentElement) ancestors.push(p);
      if (pillAncestors && ancestors.length === pillAncestors.length && ancestors.every(function (el, i) { return el === pillAncestors[i]; })) return;
      pillObserver.disconnect();
      pillObserver.observe(pillSurface, { attributes: true, childList: true, subtree: true, attributeFilter: ["class", "style", "data-phase", "data-highspeed-composer"] });
      ancestors.forEach(function (el) {
        pillObserver.observe(el, { attributes: true, childList: !!(el.classList && el.classList.contains("chat-composer-input-surface")), attributeFilter: ["class", "style", "data-highspeed-composer"] });
      });
      pillAncestors = ancestors;
    }
    function onPillMutations(records) {
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (record.type === "childList" && record.target && record.target.classList && record.target.classList.contains("chat-composer-input-surface")) {
          pillLayoutAnchor = pillSurface;
          for (var j = 0; j < record.target.children.length; j++) {
            var child = record.target.children[j];
            if (child.tagName === "P") { pillLayoutAnchor = record.target; break; }
          }
        }
      }
      queuePillSurface();
    }
    function bindPillSurface() {
      var highspeed = null;
      try { if (composer) highspeed = composer.closest('[data-highspeed-composer="true"],.highspeed-composer-surface'); } catch (e) { }
      if (state.theme === "pill" && composer && pillWasHighspeed && !highspeed) {
        var currentCard = composerCardOf(composer);
        if (currentCard && currentCard !== document.body) cardCache = currentCard;
      }
      pillWasHighspeed = !!highspeed;
      var next = state.theme === "pill" ? (highspeed || findPillSurface()) : null;
      pillLayoutAnchor = next;
      if (next && !highspeed) {
        try {
          var inputSurface = next.closest('.chat-composer-input-surface');
          var children = inputSurface && inputSurface.children;
          if (children && children.length && children[children.length - 1].tagName === "P") pillLayoutAnchor = inputSurface;
        } catch (e) { }
      }
      if (next === pillSurface) {
        if (pillSurface && pillParent !== pillSurface.parentElement) {
          unbindPillTransitions();
          bindPillTransitions();
          pillParent = pillSurface.parentElement;
        }
        try { observePillAncestors(); } catch (e) { }
        return;
      }
      var layoutAnchor = pillLayoutAnchor;
      clearPillSurface();
      if (!next) return;
      pillLayoutAnchor = layoutAnchor;
      pillSurface = next;
      pillParent = next.parentElement;
      pillWasHighspeed = !!highspeed;
      bindPillTransitions();
      ["pointerenter", "pointerleave", "focusin", "focusout"].forEach(function (type) {
        pillSurface.addEventListener(type, queuePillSurface);
      });
      try {
        pillObserver = new MutationObserver(onPillMutations);
        pillAncestors = null;
        observePillAncestors();
      } catch (e) { }
      syncPillSurface();
    }
    function applyBarTheme() {
      var pill = state.theme === "pill", compact = state.theme === "compact";
      bar.setAttribute("data-zusage-theme", state.theme);
      bar.classList.toggle("zu-pill", pill);
      bar.classList.toggle("zu-compact", compact);
      /* v226 水平对齐类只在默认档存在（药丸恒 flex-start、精简条不可见），切档即摘；
       * ⚙ 面板对齐设置块随档显隐（面板高度契约只收紧不放大，重现时转为内容区滚动） */
      var just = state.theme === "default" ? state.barJust : "between";
      bar.classList.toggle("zu-just-start", just === "start");
      bar.classList.toggle("zu-just-end", just === "end");
      var justBlock = panel.querySelector(".zu-just-block");
      if (justBlock) justBlock.style.display = state.theme === "default" ? "" : "none";
      tip.classList.toggle("zu-pill-skin", pill);
      panel.querySelectorAll('.zu-theme-choice').forEach(function (r) { r.checked = state.theme === r.value; });
      if (compact) {
        /* v146 精简模式：条永久隐藏（display:none），样式表/ariaLive 随条保留（<style> 挂条内
         * 但作用域全局，隐藏不影响 chip 样式生效）；条挪到 body 脱离卡片，React 清卡片子树
         * 时不牵连。chips 照常由 enhance 系列/syncTpsChip 在 render/heavy 维护。 */
        clearPillSurface();
        cardMode = false;
        if (!bar.isConnected || bar.parentElement !== document.body) document.body.appendChild(bar);
        if (curDisplay !== "none") { bar.style.display = "none"; curDisplay = "none"; }
        compactHid = true;
        bar.style.minWidth = "";
        bar.style.maxWidth = "";
        bar.style.visibility = "";   // pillUnsafe 遗留隐藏一并还原（写入点仅 pill 分支，防御切档路径）
        releasePads();
        hideTip(true, "compact-theme");   // 条面 tooltip 的宿主格子已不存在，强制收起
      } else if (pill) {
        cardMode = false;
        mountBelowCard();
        bar.style.minWidth = "";
        bindPillSurface();
        ensureCardPad();
      } else {
        clearPillSurface();
        main.scrollLeft = 0;
        bar.style.maxWidth = "";
        bar.style.visibility = "";   /* pillUnsafe 的安全隐藏是 pill 专属态（写入点仅 track 的 pill 分支），切回默认必须还原，否则条永久不可见 */
        if (composer) {
          var normalCard = composerCardOf(composer);
          if (normalCard && normalCard !== document.body) cardCache = normalCard;
        }
        if (cardCache) {
          cardMode = mountInCard();
          if (cardMode) releasePads();
          else { mountBelowCard(); ensureCardPad(); }
        }
      }
      if (state.theme !== "compact") {
        restoreTpsChip();   // v146：离开精简档立即摘工具行速率 chip（精简内由 render/heavy 重挂）
        /* v156：离开精简立即恢复显示（display:none 是 compact 专属态，不留到下一帧）并
         * 强制条面重建一次——compact 期 render 跳过 innerHTML，若条面 DOM 因热更占位/清子树
         * 处于空壳，签名相等会让空壳一直存活（用户实测：精简→默认后工具行下残留一条细线，
         * 数十秒后随数据变化才消失）。compactHid 区分初载 none：初载不提前露条（pill 定位
         * 契约依赖首帧前条不可见）。 */
        if (compactHid) {
          if (curDisplay !== "flex") { bar.style.display = "flex"; curDisplay = "flex"; }
          lastHtml = "";
          compactHid = false;
        }
      }
      shrink = 0;
      render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 });
      positionSettingsPanel();
    }

    function findDetRoot() {
      /* v174：会话根（最近 data-session-id 祖先）——确定性统计行按它判定归属实例，
       * 辅助对话与主分栏并存时同名 turn 不串 tracker。 */
      for (var p = composer; p && p !== document.body; p = p.parentElement) {
        if (p.hasAttribute && p.hasAttribute("data-session-id")) return p;
      }
      return null;
    }
    function setComposer(el) {
      cancelGitRefresh();
      clearPillSurface();
      releasePads();   // 旧卡片的让位边距先还原（in-card 形态不需要让位带；兜底形态由 heavy 补回）
      composer = el;
      cardCache = null;
      cardMode = false;
      detRootEl = el ? findDetRoot() : null;
      if (composer) {
        var c = composerCardOf(composer);
        if (c && c !== document.body) cardCache = c;
      }
      if (bar.classList.contains("zu-in")) mountBelowCard();   // 换卡先回落兜底形态，heavy 同 tick 重判挂载
    }
    function heavy() {
      if (inactive()) return;
      if (pid === "auto") {
        /* 兜底模式（主文档找不到带 pane 标记的输入框，shadow/iframe 场景）：沿用原
         * 单条查找链路（findComposer 含 deepFind 穿透），会话判定走 mine/pickCurrent */
        var el = wantedEl && wantedEl.isConnected ? wantedEl : findComposer();
        if (el && el !== composer) setComposer(el);
        else if (!el && composer && !composer.isConnected) setComposer(null);
        else if (el && el === composer && (!detRootEl || !detRootEl.isConnected)) detRootEl = findDetRoot();   // v177：同款窗口期补算
      } else {
        /* v61.1 多实例：composer 由协调器按 pane 派发（wantedEl），本层只对账——
         * 元素被 React 重建/pane 关闭时清绑，等下一轮协调器重新派发 */
        if (wantedEl && wantedEl.isConnected) {
          if (wantedEl !== composer) setComposer(wantedEl);
          /* v177：窗口期补算——setComposer 落在宿主「composer 已挂、data-session-id 未写」
           * 窗口时 detRootEl 为 null 且元素引用不变不再重进 setComposer，宿主补写属性后
           * det 统计行/富文本归属链会持续失效；这里按拍补算一次自愈。 */
          else if (!detRootEl || !detRootEl.isConnected) detRootEl = findDetRoot();
        } else if (composer) {
          setComposer(null);
        }
        var nextScope = readPaneScope(wantedEl, pendingSid, pid);
        var nextScopeStamp = JSON.stringify(nextScope);
        if (pendingSid !== instSid || nextScopeStamp !== scopeStamp) {
          cancelGitRefresh();
          instSid = pendingSid;
          scopeStamp = nextScopeStamp;
          /* v262：state.data 尚未就位（空渲染不再污染共享数据）时也按当前会话空渲染一遍
           * ——pickedSid/refreshWants（Git 首查路径上报）都依赖 render 跑一遍，旧行为靠
           * 被污染的 state.data（EMPTY 非 null）侥幸驱动，条件写后必须显式兜住。 */
          if (state.data || instSid) render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 });
          refreshWants();
        }
      }
      if (!composer && slot === 0) collectDiag();   // 一直找不到输入框的窗口：周期性写环境诊断（everMounted 门防覆盖）
      if (state.theme === "compact") {
        /* v146 精简模式：条常驻 body 且 display:none——挂载/几何/让位带全部停用。唯一职责
         * 是保条存活（chip 样式 <style> 与 ariaLive 随条，React 清 body 子树时补挂），
         * cardCache 照常维护（chips 的宿主查询面），让位带还原。 */
        if (!bar.isConnected || bar.parentElement !== document.body) document.body.appendChild(bar);
        if (curDisplay !== "none") { bar.style.display = "none"; curDisplay = "none"; }
        releasePads();
        cardMode = false;
      }
      if (composer) {
        if (!cardCache || !cardCache.isConnected) {
          var c = composerCardOf(composer);
          cardCache = c && c !== document.body ? c : null;
        }
        if (state.theme !== "pill" && composer.getAttribute && composer.getAttribute("data-testid") === "v4-composer-input") {
          var liveCard = composerCardOf(composer);
          if (liveCard && liveCard !== cardCache && liveCard !== document.body) cardCache = liveCard;
        }
        if (state.theme === "compact") {
          if (cardCache) nativeCtxVal = readNativeCtx(cardCache);   // v146：上下文窗口自动识别的备源照常刷新
        } else if (cardCache) {
          /* v80：优先挂输入卡片内部（工具行下）；无工具行回落 below-card 兜底 + 让位带 */
          cardMode = state.theme !== "pill" && mountInCard();
          if (state.theme === "pill") { bindPillSurface(); syncPillSurface(); }
          if (cardMode) releasePads();
          else { mountBelowCard(); ensureCardPad(); }   // React 重渲染可能重建卡片/重置内联边距，对比后再补
          nativeCtxVal = readNativeCtx(cardCache);
        } else if (cardMode) {
          mountBelowCard();
        }
      }
      enhanceCtxButton();   // v92：DOM 对账点（React 重渲染/按钮重建后兜回，幂等）
      enhanceQuotaChip();   // v96：额度 chip DOM 对账点（按钮重建/前插节点被挤走后兜回）
      enhanceModelPuller();   // v132：宿主设置页按钮 DOM 对账点（进设置页/React 重建后兜回，幂等）
      enhanceGitChip();     // v96：同点对账（React 重建工具行后重挂/位置兜回/紧凑态切换）
      syncTpsChip();        // v146：速率 chip DOM 对账点（React 重建工具行/位置挤走后兜回；非精简主题内部门控摘除）
      syncCompactBtn();     // v105：弹层压缩按钮对账点（Observer 漏触发/节点移位后兜回）
      dedupBars();          // v169：同容器双条去重（Windows 最小化/还原双条，用户报告）
      if (state.data && pid === "auto") {
        var msid = typeof state.data.mine === "string" ? state.data.mine : null;
        var pSid;
        if (msid !== null) pSid = msid;   // mine 模式：泵会在会话切换时推新 payload，这里只需同步 pickedSid
        else {
          var pc = pickCurrent(state.data);
          pSid = pc ? (pc.sess ? pc.sess.sid : pc.want) : "";
        }
        if (pSid !== pickedSid) render(state.data);   // 切换了会话：立即按缓存 payload 重渲染
      }
    }
    /* v169 同容器双条去重（Windows 最小化/还原双条，用户报告）：窗口状态切换时宿主可能
     * 短暂保留旧视图副本/重建编辑框，协调器按 pane 键派发可能短暂出现两个实例、两根条
     * 落进同一张卡（或同为 body 兜底且矩形重叠）。规则：同一容器内可见 .zusage-root >1、
     * 或两根 body 兜底条矩形重叠过半时，data-zusage-slot 大的一根让位（hideBar 抑制，
     * 对手消失后自动解除）。拆分窗格各卡各条不受影响（按容器判定）。 */
    var dupSuppress = false;
    function barVisible(b) {
      if (!b || !b.isConnected) return false;
      var st = b.style;
      if (st.display === "none" || st.visibility === "hidden") return false;
      try { var cs = getComputedStyle(b); if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return false; } catch (e) { }
      var r = b.getBoundingClientRect();
      return r.width > 40 && r.height > 8;
    }
    function barSlot(b) { var v = parseInt(b.getAttribute && b.getAttribute("data-zusage-slot"), 10); return isNaN(v) ? 99 : v; }
    function dedupBars() {
      if (state.theme === "compact") { if (dupSuppress) { dupSuppress = false; } return; }
      var rival = null;
      try {
        var bars = [];
        if (cardCache) {
          var kids = cardCache.querySelectorAll(".zusage-root");
          for (var i = 0; i < kids.length; i++) if (kids[i] !== bar && kids[i].isConnected) bars.push(kids[i]);
        }
        if (bar.parentElement === document.body) {
          document.querySelectorAll("body > .zusage-root").forEach(function (b) { if (b !== bar) bars.push(b); });
        }
        for (var j = 0; j < bars.length; j++) {
          var b = bars[j];
          var sameCard = cardCache && b.parentElement === cardCache;
          if (!sameCard && bar.parentElement === document.body) {
            var r1 = bar.getBoundingClientRect(), r2 = b.getBoundingClientRect();
            var ix = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left));
            var iy = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
            if (!(ix * iy > 0.5 * r1.width * r1.height && r2.height > 8)) continue;
          } else if (!sameCard) { continue; }
          if (barVisible(b)) { if (!rival || barSlot(b) < barSlot(rival)) rival = b; }   // 只被「可见的」对手压制；隐藏对手不构成冲突
        }
      } catch (e) { }
      if (rival && barSlot(rival) < barSlot(bar)) {
        if (!dupSuppress) { dupSuppress = true; hideBar(); }
        return;
      }
      dupSuppress = false;
    }
    function hideBar() {
      if (curDisplay !== "none") { bar.style.display = "none"; curDisplay = "none"; }
      /* v80：面板挂 body 不再随条隐藏，条隐时必须主动收起（否则面板悬空在已消失的条上方） */
      if (panel.classList.contains("open")) closeSettings(false);
      if (subPopOpen()) subPopClose(false, "bar-hidden");
      hideTip(true, "bar-hidden");   // 条面整体隐藏时 tooltip 必须跟着走（force 绕过总闸）
    }
    /* 超限气泡同步（track 每帧调）：位置贴条上沿、左缘对齐；条隐藏/超限解除/已关闭则藏。
     * exc 解除时复位 excGone，下次再超限会重新弹。display 切换与测量在同一同步块内
     * 完成后才绘制，无首帧闪位。 */
    function syncExcBubble() {
      var show = excOn && !excGone && curDisplay === "flex";
      if (!show) {
        if (!excOn) excGone = false;
        if (excBubble.style.display !== "none") excBubble.style.display = "none";
        return;
      }
      var sidStr = pickedSid || L("（未知）", "(unknown)");
      if (excSid.textContent !== sidStr) excSid.textContent = sidStr;
      if (excBubble.style.display !== "block") excBubble.style.display = "block";
      var br = bar.getBoundingClientRect();
      var r = excBubble.getBoundingClientRect();
      var left = Math.max(8, Math.round(Math.min(br.left, innerWidth - r.width - 8)));
      var top = Math.max(8, Math.round(br.top - r.height - 8));
      if (excBubble.style.left !== left + "px") excBubble.style.left = left + "px";
      if (excBubble.style.top !== top + "px") excBubble.style.top = top + "px";
    }
    /* 可见性判定（带卡片豁免）：输入框视觉卡片内部的装饰层（占位符/镜像/焦点层等）
     * 瞬时盖到输入框中心不算"被盖住"——逐帧严格判定会造成显示/隐藏来回横跳（闪烁）；
     * 设置页等真正的覆盖层不在卡片内，仍判为盖住。
     * 条外挂在输入框上方，不参与对输入框中心的遮挡（v12-v14 内嵌形态的自遮挡闪烁根因）。 */
    function coverOK(el) {
      var r = el.getBoundingClientRect();
      var rectKey = r.left + "," + r.top + "," + r.width + "," + r.height;
      var now = Date.now(), ch = coverCache.get(el);
      if (ch && ch.key === "c" && ch.rect === rectKey && now - ch.at < COVER_TTL) return ch.val;
      var val = cardHitOK(el, r);
      coverCache.set(el, { key: "c", rect: rectKey, val: val, at: now });
      return val;
    }
    function cardHitOK(el, r) {
      var hit;
      try { hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) { return true; }
      if (!hit) return false;
      if (hit === el || hit.contains(el) || el.contains(hit)) return true;
      if (cardCache && cardCache.contains(el) && cardCache.contains(hit)) return true;
      if (isOwnOverlay(hit)) return true;   // 自己的面板/气泡盖住输入框中心不算被盖（v40）
      return false;
    }
    /* 隐藏态诊断（v61）：条被判定不可见时周期性转储现场 —— body 直接子层的矩形/
     * pointer-events/透明度、elementFromPoint 命中链、幽灵子树判定与 body 的 pe 状态。
     * 定位"正常聊天窗口被误藏"类问题用；节流 4s，只写 __zusageDiag.hidden
     * （泵取回写 diag-<n>.json）。 */
    var lastHiddenDiagAt = 0;
    function elDesc(el) {
      if (!el) return String(el);
      var cls = el instanceof Element ? (el.getAttribute("class") || "") : "";
      return el.tagName + (el.id ? "#" + el.id : "") + (cls ? "." + String(cls).slice(0, 60) : "");
    }
    function diagHidden(r) {
      var now = Date.now();
      if (now - lastHiddenDiagAt < 4000) return;
      lastHiddenDiagAt = now;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var hit = null, chain = [], bodyPE = "";
      try {
        hit = document.elementFromPoint(cx, cy);
        chain = (document.elementsFromPoint(cx, cy) || []).slice(0, 8).map(elDesc);
        bodyPE = getComputedStyle(document.body).pointerEvents;
      } catch (e) { }
      var kids = [];
      try {
        var cs = document.body.children;
        for (var i = 0; i < cs.length; i++) {
          var el = cs[i], kr = el.getBoundingClientRect(), st = getComputedStyle(el);
          kids.push({
            el: elDesc(el),
            rect: [Math.round(kr.left), Math.round(kr.top), Math.round(kr.width), Math.round(kr.height)],
            pe: st.pointerEvents, op: st.opacity, vis: st.visibility, disp: st.display,
            covers: (kr.width >= 4 && kr.height >= 4 && cx >= kr.left && cx <= kr.right && cy >= kr.top && cy <= kr.bottom) ? 1 : 0,
          });
        }
      } catch (e) { }
      FATAL.hidden = {
        time: new Date().toISOString(),
        ghost: inGhostSubtree(composer),
        modal: modalOpen(),   // v62：模态弹窗判定（弹窗打开时条本就该收起，用于区分"误藏"与"应藏"）
        bodyPE: bodyPE,
        hit: elDesc(hit),
        chain: chain,
        composerCenter: [Math.round(cx), Math.round(cy)],
        composerRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        bodyKids: kids,
      };
    }
    /* 分屏现场诊断（v61）：转储全部可见 textarea 的祖先链（含 data-* 属性）、全页
     * iframe 的矩形与 src、pane/layout 相关 localStorage 键——用于确认"pane → 工作区/
     * 会话"能否从 DOM 映射（多实例状态条的数据源设计依据）。随 mount 诊断每 5s 刷新。 */
    function diagPanes() {
      try {
        var composers = [];
        document.querySelectorAll(COMPOSER_SEL + ",textarea").forEach(function (ta) {
          if (!visible(ta)) return;
          var r = ta.getBoundingClientRect();
          if (r.top < innerHeight * 0.4) return;
          var sess = null, pane = null, tag = elDesc(ta);
          for (var p = ta; p && p !== document.body; p = p.parentElement) {
            if (sess === null && p.hasAttribute && p.hasAttribute("data-session-id")) sess = p.getAttribute("data-session-id");
            if (pane === null && p.hasAttribute && p.hasAttribute("data-pane-id")) pane = p.getAttribute("data-pane-id");
          }
          composers.push({ tag: tag, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], pane: pane, sess: sess });
        });
        var webviews = [];
        document.querySelectorAll("webview,iframe").forEach(function (fr) {
          var r = fr.getBoundingClientRect();
          webviews.push({ tag: fr.tagName, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], src: String(fr.src || "").slice(0, 130) });
        });
        var attrHits = [];
        document.querySelectorAll("[data-session],[data-session-id],[data-workspace],[data-workspace-path],[data-pane],[data-pane-id],[data-task-id]").forEach(function (el) {
          var parts = [el.tagName];
          for (var i = 0; i < el.attributes.length; i++) {
            var a = el.attributes[i];
            if (/^data-(session|workspace|pane|task)/i.test(a.name)) parts.push(a.name + "=" + String(a.value).slice(0, 60));
          }
          attrHits.push(parts.join(" "));
        });
        var lsPane = [];
        try {
          Object.keys(localStorage).forEach(function (k) {
            if (/pane|split|layout|last-session/i.test(k)) lsPane.push(k + " = " + String(localStorage.getItem(k)).slice(0, 160));
          });
        } catch (e) { }
        FATAL.panes = { time: new Date().toISOString(), composers: composers, webviews: webviews.slice(0, 10), attrHits: attrHits.slice(0, 30), lsPane: lsPane.slice(0, 20) };
      } catch (e) { FATAL.panes = { err: String((e && e.stack) || e) }; }
    }

    function track() {
      if (inactive()) return;   // 旧实例罢工，把舞台让给新实例
      try {
        /* v115：窗口不可见（最小化/被遮挡）时整帧跳过——渲染无意义；rAF 在多数后台形态
         * 已停发，这里兜住仍派帧的平台/形态，恢复可见后自调度自然续上并由下一帧重判。 */
        if (document.hidden) return;
        syncExcBubble();   // 超限气泡：显示/隐藏/贴条定位（内部自判状态，隐藏分支零开销）
        if (!composer || !composer.isConnected) { hideSince = 0; hideBar(); return; }
        if (state.theme === "compact") {
          /* v146 精简模式：条已 display:none，几何/显隐/收缩全部停用（超限气泡由
           * syncExcBubble 的 curDisplay 门自兜隐藏）；面板周期跟随与诊断保留，帧循环自续。 */
          everMounted = true;
          positionSettingsPanel();   // v155：compact 早退前补两面板的逐帧跟随（内部 open 门，关闭零开销）
          positionSubPop();
          if (slot === 0 && Date.now() - lastMountDiagAt > 5000) {
            lastMountDiagAt = Date.now();
            FATAL.mount = {
              version: VERSION, mode: "compact", theme: themeDark ? "dark" : "light", picked: pickedSid,
              tpsChip: !!(tpsChipCache && tpsChipCache.isConnected),
              quotaChip: !!(quotaChipCache && quotaChipCache.isConnected),
              gitChip: !!(gitChipCache && gitChipCache.isConnected)
            };
          }
          return;
        }
        if (cardMode) {
          /* v80 in-card 对账：React 整子树重挂（切会话 key 变化）会连外来节点一起丢，
           * 帧率级检查补挂；卡片本身被重建时 cardCache 断连，heavy 低频重找后再挂 */
          if (!bar.isConnected || bar.parentElement !== cardCache) {
            cardMode = mountInCard();
            if (!cardMode) mountBelowCard();
          }
        } else if (cardCache && (state.theme === "pill" || !paddedCard || paddedCard.style.marginBottom !== CARD_MARGIN)) {
          ensureCardPad();   // 流式期间 React 重置内联边距时立刻补回（仅 below-card 兜底形态）
        }
        var r = composer.getBoundingClientRect();
        var on = r.width > 60 && r.height > 14 && r.bottom > 0 && r.top < innerHeight &&
          !ghostOf(composer) &&          // 设置页等幽灵壳（opacity-0/inert）：视觉已隐藏（v61，v115 TTL 缓存）
          !inSettingsView(composer) &&   // v91：设置页排除的第四处收口——已绑到设置页编辑框时不显示（防其它绑定路径漏排除）
          !modalOpenCached() &&          // v62：模态弹窗（模型配置等）打开时整体收起，弹窗内容不归条管（issue #9；v115 TTL 缓存）
          (reallyVisible(composer, true) || coverOK(composer));
        if (!on) {
          if (slot === 0) diagHidden(r);   // 隐藏现场周期转储（v61，节流 4s；仅 0 号实例写，槽位共享）
          // 迟滞：连续 400ms 判定不可见才隐藏，瞬时失败（流式装饰层等）不闪
          if (!hideSince) hideSince = Date.now();
          if (Date.now() - hideSince > 400) { hideBar(); }
          return;
        }
        hideSince = 0;
        /* v177：让位抑制期间不得复显——dedupBars 只在 heavy（600ms）里锁 dupSuppress，
         * track 每帧无条件复显会把抑制打穿（首帧隐藏、次帧复显，此后 heavy 因已锁不再隐藏
         * = 双条永久并存，Windows 最小化/还原场景失效）。复显在 heavy 解除抑制后的下一帧发生。 */
        if (!dupSuppress && curDisplay !== "flex") { bar.style.display = "flex"; curDisplay = "flex"; }
        if (state.theme === "pill") {
          ensureCardPad();
          adjustPillBottom();
          /* 不安全（无法让位且会盖住输入区）时不整条 display 切换：visibility 隐藏保持
           * offsetHeight 可测，几何/布局恢复后下一帧自动复显，无每帧显隐抖动。 */
          var wantVisibility = pillUnsafe ? "hidden" : "";
          if (bar.style.visibility !== wantVisibility) bar.style.visibility = wantVisibility;
        }
        /* 悬浮在输入框视觉卡片正下方（v58 定位回归）：v55-v57 改贴窗口底，新对话 hero 页
         * 输入框垂直居中时条与输入框彻底脱钩（用户点名回退）。让位带 24px 比条高+顶缝
         * 短 ~7px，条底落进原生底部留白、距窗口底 ~7px —— v54 的"条下 15px 空白"不复发。
         * 水平仍与卡片左缘对齐 */
        var anchor = (state.theme === "pill" && (pillLayoutAnchor || pillSurface)) || cardCache || composer;
        var ar = anchor.getBoundingClientRect();
        if (!cardMode) {
          /* 悬浮在输入框视觉卡片正下方（v58 定位回归）：v55-v57 改贴窗口底，新对话 hero 页
           * 输入框垂直居中时条与输入框彻底脱钩（用户点名回退）。让位带 24px 比条高+顶缝
           * 短 ~7px，条底落进原生底部留白、距窗口底 ~7px —— v54 的"条下 15px 空白"不复发。
           * 水平仍与卡片左缘对齐。v80 起仅 below-card 兜底形态走这里。 */
          var left = Math.round(ar.left);
          /* 药丸与卡片底边间距 8px、距窗口底 8px（用户规格 2026-10-29）；默认兜底形态维持 4px/2px。 */
          var pillGap = state.theme === "pill" ? 8 : 4;
          var bottomGap = state.theme === "pill" ? 8 : 2;
          var bottomLimit = state.theme === "pill" && pillBottomLimit !== null ? pillBottomLimit : innerHeight;
          var top = Math.max(8, Math.min(Math.round(ar.bottom + pillGap), bottomLimit - bar.offsetHeight - bottomGap));
          if (state.theme === "pill") {
            var available = Math.max(0, Math.min(ar.width, innerWidth - 16));
            var maxW = Math.round(available) + "px";
            if (bar.style.minWidth) bar.style.minWidth = "";
            if (bar.style.maxWidth !== maxW) bar.style.maxWidth = maxW;
            var width = bar.getBoundingClientRect().width;
            left = Math.max(8, Math.min(Math.round(ar.left + (ar.width - width) / 2), Math.round(innerWidth - width - 8)));
          } else {
            /* 宽度锁死卡片（v63 对齐，v66 收缩）：min=max-width = 卡片实测宽。 */
            var minW = Math.max(60, Math.round(ar.width));
            if (bar.style.minWidth !== minW + "px") bar.style.minWidth = minW + "px";
            if (bar.style.maxWidth !== minW + "px") bar.style.maxWidth = minW + "px";
          }
          if (left !== lastPos[0] || top !== lastPos[1]) {
            bar.style.left = left + "px"; bar.style.top = top + "px";
            lastPos = [left, top];
          }
        }
        /* in-card 形态（v80）：无坐标跟随、无锁宽——宽度由卡片 flex-col 的 stretch 撑满内宽。
         * 两种形态共用的收缩判定：内容超宽不撑破卡片，分级收缩：先隐藏「本轮/会话累计」
         * 的缓存命中率（核心项 tps/上下文/会话累计不动，明细仍在悬停 tooltip），
         * 迟滞 +12px/-120px 防数值刷新在阈值附近来回闪；仍装不下由 .zu-main 右缘渐隐
         * 兜底（.zu-clip）。测量基准都是 bar 自身内容宽，形态无关。 */
        var ov = main.scrollWidth - main.clientWidth;
        var ns = shrink;
        if (!shrink && ov > 12) ns = 1;
        else if (shrink && ov < -120) ns = 0;
        if (ns !== shrink) { shrink = ns; render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 }); }
        var clip = state.theme !== "pill" && main.scrollWidth > main.clientWidth + 1;
        if (clip !== fadeOn) { fadeOn = clip; main.classList.toggle("zu-clip", clip); }
        positionSettingsPanel();
        positionSubPop();
        everMounted = true;
        if (slot === 0 && Date.now() - lastMountDiagAt > 5000) {
          lastMountDiagAt = Date.now();
          var br = bar.getBoundingClientRect(), bh = null;
          try { bh = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); } catch (e) { }
          FATAL.mount = {
            version: VERSION, mode: cardMode ? "in-card" : "below-card", bodyPE: (function () { try { return getComputedStyle(document.body).pointerEvents; } catch (e) { return ""; } })(),
            panes: diagPanes(),
            theme: themeDark ? "dark" : "light",
            /* 字体跟随（v64）实测：条面计算字体 + 客户端两个字体变量的原值（验证 var 命中） */
            font: (function () {
              try {
                var rs = getComputedStyle(document.documentElement), cs = getComputedStyle(bar);
                return { fam: String(cs.fontFamily).slice(0, 90), size: cs.fontSize,
                  mono: String(rs.getPropertyValue("--font-mono")).slice(0, 80).trim(),
                  ui: String(rs.getPropertyValue("--ui-font-size")).trim() };
              } catch (e) { return "ERR:" + e; }
            })(),
            tip: (function () { return { stats: tipStats, disp: tip.style.display, barRect: (function () { var b = bar.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })() }; })(),
            composerRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            anchorRect: [Math.round(ar.left), Math.round(ar.top), Math.round(ar.width), Math.round(ar.height)],
            barRect: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)],
            /* 条中心命中元素：若被应用层盖住（z 序问题）此处直接暴露 */
            barHit: bh ? bh.tagName + "." + String(bh.className).slice(0, 40) : String(bh),
            bottomGap: Math.round(innerHeight - ar.bottom),
            nativeCtx: nativeCtxVal,
            quota: { providerId: effectiveQuotaProvider(), modelId: quotaModel, sourceId: quotaSourceId,
              selected: !!quotaSelection, status: lastQuota ? lastQuota.status : "unavailable", chip: !!quotaChipCache },
            picked: pickedSid,
            exc: excOn ? (excGone ? "on-gone" : "on") : 0,
            href: String(location.href).slice(0, 120),
            lsVals: (function () {
              try {
                var out = [];
                Object.keys(localStorage).forEach(function (k) {
                  /* 只转储本插件命名空间：宿主 localStorage 可能存任意键值（含会话/令牌类
                   * 数据），诊断文件不该整库带走（2026-10-24 审计 O9）。 */
                  if (String(k).indexOf("zusage") !== 0) return;
                  out.push(k + " = " + String(localStorage.getItem(k)).slice(0, 90));
                });
                var wk = [];
                Object.keys(window).forEach(function (k) {
                  if (/zcode|session|store|state|tab/i.test(k)) wk.push(k);
                });
                out.push("WINDOW_KEYS=" + wk.join("|").slice(0, 300));
                return out.join("\n").slice(0, 7000) || "(none)";
              } catch (e) { return "ERR:" + e; }
            })(),
            lastSessionVals: (function () {
              try {
                var out = [];
                Object.keys(localStorage).forEach(function (k) {
                  if (/last-session/i.test(k)) out.push(k.slice(22) + "=" + String(localStorage.getItem(k)).slice(0, 50));
                });
                return out.join(" | ").slice(0, 1000) || "(none)";
              } catch (e) { return "ERR:" + e; }
            })(),
          };
        }
      } catch (e) {
        if (Date.now() - (track.errAt || 0) > 5000) {
          track.errAt = Date.now();
          FATAL.trackErr = String((e && e.stack) || e);
        }
      } finally {
        if (!inactive()) frame = requestAnimationFrame(track);   // 自调度循环：异常绝不能杀死循环（setInterval 无此问题，rAF 有）
      }
    }

    heavyTimer = setInterval(heavy, 600);
    heavy();
    frame = requestAnimationFrame(track);
    /* v105：弹层压缩按钮的即时重注入观察器。弹层每次打开/关闭都是 body 子树变异，rAF 去抖
     * 合并同帧爆发；自身注入也会触发下一轮回查（存在性幂等，无环）。异常只降级为 heavy 兜底。 */
    var hcObserver = null, hcObsQueued = false;
    try {
      hcObserver = new MutationObserver(function () {
        if (state.theme === "pill" && pillSurface && pillSurface.parentElement !== pillParent) queuePillSurface();
        if (hcObsQueued) return;
        hcObsQueued = true;
        requestAnimationFrame(function () {
          hcObsQueued = false;
          syncCompactBtn();
        });
      });
      hcObserver.observe(document.body, { childList: true, subtree: true });
    } catch (e) { FATAL.cptErr = String(e); }

    syncPanel();
    if (state.data) render(state.data);   // 已有共享数据（后 spawn 的实例）直接渲染，不用零值覆盖
    else render({ session: {}, last_turn: {}, today: {}, context_window: 0 });

    function dispose() {
      if (instanceDisposed) return;
      instanceDisposed = true;
      clearInterval(heavyTimer);
      clearInterval(bridge.timer);   // v71：pane 销毁即停能力检测并释放 store 订阅
      clearInterval(subRateTimer);   // v97：子代理面板速率刷新定时器
      subRateTimer = 0;
      subPopMode = "closed"; subPopEntry = null; subPopSig = "";   // v217：浮层态随实例销毁复位
      if (subPopHideTimer) { clearTimeout(subPopHideTimer); subPopHideTimer = 0; }
      /* v244：重启请求在途的两路还原定时器随实例销毁（热重载后旧实例闭包不留 90s 滞留） */
      if (relaunchAckTimer) { clearTimeout(relaunchAckTimer); relaunchAckTimer = 0; }
      if (relaunchAliveTimer) { clearTimeout(relaunchAliveTimer); relaunchAliveTimer = 0; }
      bridgeDetach(bridge.handle);
      cancelAnimationFrame(frame);
      cancelTipGrace();
      if (excCopied) clearTimeout(excCopied.timer);
      if (themeObserver) themeObserver.disconnect();
      clearPillSurface();
      if (quotaSelectionObserver) quotaSelectionObserver.disconnect();
      quotaSelectionObserver = null; quotaPaneRoot = null; quotaSelection = null;
      if (hcObserver) hcObserver.disconnect();   // v105：停弹层压缩按钮观察器
      clearTimeout(acFlashTimer); acFlashTimer = 0;   // v189：阈值行高亮计时器随实例销毁
      closeCompactDlg();   // v105：本实例打开的确认弹框与 Esc/Enter 监听一并摘除
      cleanupMpModal();   // v130：本实例打开的模型拉取弹窗与 Esc 监听一并摘除（body 级 DOM 不随 pane 走）
      restoreModelPuller();   // v132：pane 关闭后同步摘除宿主设置页按钮（其余实例的 enhance 会重建）
      globalListeners.forEach(function (binding) {
        binding[0].removeEventListener(binding[1], binding[2], binding[3]);
      });
      globalListeners = [];
      releasePads();
      if (ctxBtnCache) { restoreCtxButton(ctxBtnCache); ctxBtnCache = null; }   // v92：还原原生按钮形态
      restoreQuotaChip();   // v95：摘除额度 chip（不留孤儿节点）
      restoreTpsChip();   // v146：摘除精简模式速率 chip（含在显 tooltip）
      restoreGitChip();   // v96：摘掉本 pane 的 Git chip（含在显 tooltip）
      /* v180 review：行内速率 chip 挂在宿主 Agent 行内（非条面自家节点），dispose
       * 不摘会在 pane 输入框暂时不可见被协调器回收时冻结在旧速率上、悬停还弹出
       * 已 dispose 实例的 tooltip——趁 wantedEl/composer 尚在按 pane 根摘净。 */
      try {
        var srr = subRowPaneRoot();
        if (srr) {
          var staleChips = srr.querySelectorAll(".zu-subrate");
          for (var sc = 0; sc < staleChips.length; sc++) { try { staleChips[sc].remove(); } catch (e) { } }
          if (subTipFor && (srr.contains(subTipFor) || !subTipFor.isConnected)) hideSubTip();
        }
      } catch (e) { }
      wantedEl = composer = cardCache = null;
      bar.remove();
      panel.remove();   // v80：面板挂 body，dispose 需单独摘除
      subPanel.remove();
      tip.remove();
      excBubble.remove();
    }
    var api = {
      pid: pid, slot: slot, dispose: dispose,
      ownsComposer: function (el) { return !inactive() && composer === el; },
      attach: function (el, sid) {   // 协调器派发：pane 最靠下的可见输入框 + 其 data-session-id
        if (inactive()) return;
        wantedEl = el;
        pendingSid = sid || "";
        heavy();   // 立即对账（composer 重建/pane 关闭的最快收敛路径）
      },
      render: render,
      applyBarTheme: applyBarTheme,
      syncUpdate: syncUpdate,
      rebuild: function () {
        gear.setAttribute("aria-label", L("打开状态条设置", "Open status bar settings"));
        buildPanel();
        rebuildExcBubble();
        syncPanel();
      },
      getSid: function () { return pickedSid || ""; },
      getQuotaSelection: function () {
        if (inactive()) return null;
        if (quotaSelection) return quotaSelection;
        var sid = instSid || pickedSid || "";
        return sid ? { sid: sid, providerId: effectiveQuotaProvider(), modelId: quotaModel } : null;
      },
      getScope: function () { return inactive() ? null : readPaneScope(wantedEl, pickedSid, pid); },
      gitTouch: function () {
        if (inactive()) return;
        enhanceGitChip();
      },   // v96：主进程推送 git 状态后即时对账（不等 heavy）
      /* v71 确定性历史行数据源：DOM turn id（turnId 或 productTurnId 形态）→ tracker 统计 */
      statsFor: function (tid) {
        var h = bridge.handle;
        if (!h || h.dead || typeof tid !== "string") return null;
        if (!sideHandleValid(h)) { bridgeDetach(h); updateLive(); return null; }
        var s = h.tracker.get(tid);
        if (!s) {
          var key = h.alias[tid];
          if (key && key !== tid) s = h.tracker.get(key);
        }
        return s;
      },
      /* v174：本实例的会话根（detach/dispose 后为 null）——确定性统计行归属判定用 */
      detRoot: function () { return !inactive() && detRootEl && detRootEl.isConnected ? detRootEl : null; },
      /* v174：tid 是否本实例当前活跃轮（productTurnId 或经 alias 映射）——富文本只追活跃轮 */
      isCurrentTurn: function (tid) {
        var h = bridge.handle;
        if (!sideHandleValid(h) || !tid) return false;
        if (tid === bridge.turnId) return true;
        return h.alias[tid] === bridge.turnId;
      },
      /* v86 诊断：桥接绑定状态与当前快照窗口（行数/序号/代际）——重启后历史轮可见性取决于它 */
      bridgeInfo: function () {
        var h = bridge.handle, info = { bound: !!(h && !h.dead), sid: h ? String(h.sid).slice(-8) : "", rebinds: bridge.rebinds || 0 };
        if (!info.bound) return info;
        var snap = null;
        try { var st = h.store.getState(); snap = st && st.snapshot; } catch (e) { info.err = String(e); }
        if (snap) {
          info.win = snap.rows && Array.isArray(snap.rows.window) ? snap.rows.window.length : null;
          info.seq = snap.seq;
          info.epoch = String(snap.logEpoch).slice(0, 12);
          info.heads = 0;
          try { snap.rows.window.forEach(function (r) { if (r && r.kind === "turnHeader") info.heads++; }); } catch (e) { }
        }
        return info;
      },
      rotatorStats: function () { return inactive() ? null : { stats: liveStatsCur, model: quotaModel, provider: quotaProvider, session: lastView && lastView.session }; },
      liveEl: function () { return liveEl; },   // 测试缝：实时段节点引用
      liveIconKind: function () { return liveIconCur; },   // 测试缝：当前 chip 图标（think/bolt/空）
    };
    instances.push(api);
    applyBarTheme();
    refreshWants();
    return api;
  }
})();