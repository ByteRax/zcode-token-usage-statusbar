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

