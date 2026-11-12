    /* ---------- renderer store 桥客户端（v71，实例级）：一个 pane 一个订阅 ----------
     * 低频（2s）能力检测：API 在 + diagnostics 里有本 pane 会话的 topic → 绑定 store；
     * 绑定后 tracker.ingest 由订阅推送驱动（实时），store 关闭/换代（getState null /
     * 快照 sessionId 变）→ off 释放，下轮 tick 重绑。全链路失败 = 降级 DB 路径。 */
    function bridgeDetach(handle) {
      if (!handle || handle.dead) return;
      handle.dead = true;
      handle.snap = null;   // issue #309：整窗快照记录不随已死 handle 滞留
      try { if (handle.off) handle.off(); } catch (e) { }   // 停订阅 + dispose tracker
      try { handle.store.off(); } catch (e) { }
      if (bridge.handle === handle) { bridge.handle = null; bridge.turnId = ""; }
      subRateDetach();   // 主桥释放（换代/切换/世代失效）时子代理速率桥一并释放
    }
    /* ---------- 子代理运行期速率桥（v97）：主会话 rows 的 subagent 行自带
     * childSessionId（turn-stats 的 runningSubagents 集合），据此用同一套 zuTryBindStore
     * 为**每个**运行中的子代理绑定会话 store，字符增量 ÷ c2t 估算各自输出 tok/s；
     * 主 chip 显示合计（Σ 有效槽位，并行 ≥2 个时动词后缀 ×N），tooltip/明细面板按
     * 槽位逐个展示。运行中请求未入库（DB 完成才写行，150s 实测零 running 行），这是
     * 唯一的实时来源；子代理思考文本若不进 rows（与主会话同款限制），characterRate
     * 为 null，该槽位速率缺席。生命周期跟随主桥：主桥释放/换代即全解绑；行结束
     * （runningSubagents 收敛）下一次 updateLive 自然解绑。
     * 上限保护：宿主 schema 允许 64 个并行 subagent，全绑会让订阅失控——只绑
     * rowId 最大（最新派发）的前 8 个，其余不估算（turn-stats 已按 rowId 升序给出）。 */
    var MAX_SUB_SLOTS = 8;
    var subRate = { slots: {}, sum: { rate: null, at: 0, count: 0 } };
    /* 释放槽位的绑定资源但保留槽位（want/retryAt）：绑定失败/首调 detach 时等待
     * 2s 后重试；对未绑定槽位（handle 为 null）调用也安全。 */
    function subSlotReset(sl) {
      if (sl.handle) sl.handle.dead = true;
      try { if (sl.off) sl.off(); } catch (e) { }
      try { if (sl.store) sl.store.off(); } catch (e) { }
      if (sl.tracker) { try { sl.tracker.dispose(); } catch (e) { } }
      sl.handle = null; sl.store = null; sl.tracker = null; sl.off = null;
      sl.rate = null; sl.calib = null; sl.st = "";   // v180：清 st，防诊断把重试窗口计成 bound/rate
      sl.retryAt = Date.now() + 2000;
    }
    function subSlotDetach(sid) {   // 彻底移除槽位（行结束/主桥释放）
      var sl = subRate.slots[sid];
      if (!sl) return;
      subSlotReset(sl);
      delete subRate.slots[sid];
    }
    function subRateDetach() {   // 全解绑（主桥释放/换代/世代失效）
      for (var sid in subRate.slots) subSlotDetach(sid);
      subRate.sum = { rate: null, at: 0, count: 0 };
    }
    /* 合计视图：Σ 3 秒内有效的槽位速率；全部无效/过期时为 {rate:null}（chip 回退状态词）。 */
    function subRateRecompute() {
      var now = Date.now(), sum = 0, at = 0, count = 0;
      for (var sid in subRate.slots) {
        var sl = subRate.slots[sid];
        if (sl.rate != null && now - sl.at <= 3000) { sum += sl.rate; count++; if (sl.at > at) at = sl.at; }
      }
      subRate.sum = count ? { rate: sum, at: at, count: count } : { rate: null, at: 0, count: 0 };
    }
    /* 单槽位展示文案（tooltip/明细面板共用）：有效速率 →「估 X t/s」；已绑但无速率
     * （思考期）→「估算中…」；未绑槽位 → 空串。 */
    function subRateSlotText(sid) {
      var sl = subRate.slots[sid];
      if (!sl) return "";
      var now = Date.now();
      return sl.rate != null && now - sl.at <= 3000
        ? L("估 ", "est ") + sl.rate.toFixed(1) + L(" t/s", " t/s")
        : L("估算中…", "estimating…");
    }
    /* ---------- 子代理行内速率 chip（v176）：把逐槽位估算/快照真实值投到会话流 Agent 行 ----------
     * 宿主 v4 行 testid = TID_V4_SUBAGENT_OPEN_SIDE_PANE + childSessionId（宿主 e2e 锁定的
     * 稳定契约），与上面 subRate 槽位键天然同源，两态互补：
     * ① 运行中槽位 3s 内有估算速率 →「估 X t/s」；思考期无字符流不显示（行内流光动画
     *    已指示运行中）；
     * ② 槽位收敛后读泵快照 sub.list 的 tps_avg（已完成段加权平均真实速率，查询无时间窗，
     *    重启后历史行也能回填）→「X t/s」；槽位解绑与泵推送之间有几秒无 chip 间隙，属预期。
     * chip 插在 .tool-summary-content 之后（缺该节点退回行末尾）；React 对未知末尾节点
     * 通常不回收，行虚拟化卸载/整行重挂时 chip 随节点消亡——本函数无状态对账，每拍按期望
     * 形态幂等重建，不持有 chip 引用。扫描根 = composer/wantedEl 祖先链最近
     * [data-session-id]（本 pane 会话壳）：分屏同会话时两实例各管各 pane，绝不互相覆写。
     * 悬停 tooltip 内容构建器挂 chip.__zuT，显隐由模块级 subTip 的委托监听驱动。 */
    var SUBROW_TID_PREFIX = "v4-subagent-open-side-pane-";
    function subRowPaneRoot() {
      var el = (composer && composer.isConnected) ? composer : (wantedEl && wantedEl.isConnected ? wantedEl : null);
      try {
        while (el && !(el.hasAttribute && el.hasAttribute("data-session-id"))) el = el.parentElement;
      } catch (e) { return null; }
      return el && el.isConnected ? el : null;
    }
    function subRowDurText(ms) {
      if (!(ms >= 1000)) return sec(ms);
      var total = Math.floor(ms / 1000), m = Math.floor(total / 60), s = total % 60;
      return m ? L(m + "分" + (s ? s + "秒" : ""), m + "m" + (s ? " " + s + "s" : "")) : L(total + "秒", total + "s");
    }
    /* tooltip 构建器收「数据包」而非元素：模块 showSubTip 的调用约定是
     * el.__zuT.buildTip(el.__zuT)（同 tpsChipTipHTML(t)），包里携带取数所需
     * 全部字段——v178 首版误按元素取 __zu* 导致全部 undefined、tooltip 恒显
     * 「— t/s」+无名（实机截图定案）。 */
    function subRowTipHTML(t) {
      var csid = t.csid || "", mode = t.mode || "";
      var s1 = null, list = (lastSub && lastSub.list) || [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].sid === csid) { s1 = list[i]; break; }
      var name = (s1 && (String(s1.task || "").trim() || String(s1.title || "").trim())) ||
        String(t.title || "").trim() || L("子代理", "Sub-agent");
      var agent = s1 && s1.agent ? String(s1.agent) : "";
      /* 作用域样式挂在内容串里（同 quotaTip/tpsTip）：浮层是 body 级共享元素，样式随内容走 */
      var out = "<style>" +
        '.zusage-subrate-tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px;overflow-wrap:anywhere}' +
        '.zusage-subrate-tip .rt-row{display:flex;gap:12px;margin:4px 0;align-items:flex-start}' +
        '.zusage-subrate-tip .rt-row b{flex:0 0 86px;min-width:0;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500}' +
        '.zusage-subrate-tip .rt-row span{min-width:0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}' +
        ".zusage-subrate-tip .sub-agent{font-weight:400;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-size:.9em}" +
        "</style>";
      out += '<div class="rt-h">' + ttEsc(name) + (agent ? ' <span class="sub-agent">' + ttEsc(agent) + "</span>" : "") + "</div>";
      var rateTxt = (t.rate || "—") + L(" t/s", " t/s");
      if (mode === "run") {
        /* v334：状态面板「运行中」兜底态（无槽位无数据）——既无估算也无将来的估算，
         * 不挂估速口径，只显事实与 DB 已知量。 */
        out += ttRow(L("状态", "State"), L("运行中", "running"));
        if (s1) {
          if (s1.input != null) out += ttRow(L("输入", "Input"), fmt(s1.input) + L(" token", " tokens"));
          out += ttRow(L("输出", "Output"), fmt(s1.output) + L(" token（含思考）", " tokens (thinking incl.)"));
          out += ttRow(L("请求数", "Requests"), (s1.requests || 0) + L(" 次", " requests"));
        }
        return out;
      }
      if (mode === "est") {
        out += ttRow(L("估速", "Estimate"), rateTxt);
        var sl = subRate.slots[csid];
        if (sl && sl.store) {
          try {
            var st = sl.store.getState(), snap = st && st.snapshot;
            var tid = zuActiveTurnId(snap), ts = (tid && sl.tracker) ? sl.tracker.get(tid) : null;
            if (ts && ts.startedAt) out += ttRow(L("已运行", "Running for"), subRowDurText(Date.now() - ts.startedAt));
            if (ts && ts.totalCharacters > 0) {
              var c2t = sl.calib || (bridge.handle && bridge.handle.charsPerToken) || DEFAULT_CHARS_PER_TOKEN;
              out += ttRow(L("累计输出", "Output"), "≈" + fmt(ts.totalCharacters / c2t) + L(" token", " tokens"));
            }
          } catch (e) { }
        }
        out += ttRow(L("口径", "Basis"), L("字符增量估算；完成后切换真实值", "Text-delta estimate; actual value on completion"));
      } else {
        out += ttRow(L("平均速率", "Average rate"), rateTxt);
        if (s1) {
          if (s1.input != null) out += ttRow(L("输入", "Input"), fmt(s1.input) + L(" token", " tokens"));
          out += ttRow(L("输出", "Output"), fmt(s1.output) + L(" token（含思考）", " tokens (thinking incl.)"));
          out += ttRow(L("请求数", "Requests"), (s1.requests || 0) + L(" 次", " requests"));
          if (s1.started || s1.last) out += ttRow(L("起始时间", "Time span"),
            (s1.started ? fmtStartS(s1.started) : "—") + " - " + (s1.last ? fmtStartS(s1.last) : "—"));
        }
        out += ttRow(L("口径", "Basis"), L("已完成段加权平均（Σ输出 ÷ Σ生成耗时）", "Completed-segment weighted average"));
      }
      return out;
    }
    function renderSubAgentRows() {
      if (inactive()) return;
      if (!(composer && composer.isConnected) && !(wantedEl && wantedEl.isConnected)) return;
      var rootEl = subRowPaneRoot();
      if (!rootEl) return;
      /* v178 ⚙「子代理行内速率」门：关闭即摘净本 pane 已有 chip 并收起本 pane 的悬停
       * 浮层，重开由 0.1s 心跳自然重建；只门控行内展示——槽位估算与主 chip「子代理
       * 运行中 · 估 X t/s」合计是独立功能，照常工作。 */
      if (!state.show.subRate) {
        var staleChips = rootEl.querySelectorAll(".zu-subrate");
        for (var sc = 0; sc < staleChips.length; sc++) { try { staleChips[sc].remove(); } catch (e) { } }
        /* 只收本类 chip 的浮层（v334 修复）：宽条件会在 subRate 关 + wfChip 开时杀掉
         * 悬停中的 .zu-wfrun/.zu-substat tooltip（10Hz 心跳常驻执行，闪烁）；其它类
         * chip 的断连收起由各自渲染器尾部分支与 dispose 链负责。 */
        if (subTipFor && subTipFor.classList && subTipFor.classList.contains("zu-subrate") &&
            (rootEl.contains(subTipFor) || !subTipFor.isConnected)) hideSubTip();
        return;
      }
      var now = Date.now(), list = (lastSub && lastSub.list) || [], bySid = {};
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].sid) bySid[list[i].sid] = list[i];
      var rows;
      try { rows = rootEl.querySelectorAll('[data-testid^="' + SUBROW_TID_PREFIX + '"]'); } catch (e) { return; }
      var dark = true;
      try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
      for (var r = 0; r < rows.length; r++) {
        var el = rows[r], tattr = String(el.getAttribute("data-testid") || "");
        if (tattr.length <= SUBROW_TID_PREFIX.length) continue;
        var csid = tattr.slice(SUBROW_TID_PREFIX.length);
        var sl = subRate.slots[csid];
        var rate = (sl && sl.rate != null && now - sl.at <= 3000) ? sl.rate : null;
        var mode = rate != null ? "est" : "";
        if (!mode && bySid[csid] && bySid[csid].tps_avg > 0) { rate = bySid[csid].tps_avg; mode = "real"; }
        var chip = el.querySelector(".zu-subrate");
        if (!mode) { if (chip) { try { chip.remove(); } catch (e) { } } continue; }
        var band = tpsBand(rate);
        var bandCls = band ? band.cls : "ok";
        /* 十档色的浅色加深版是后代选择器（.zu-light .ok），档位类挂内层 span、
         * zu-light 挂 chip 本体（同 syncTpsChip 结构），两态切换只换内层。 */
        var cls = "zu-subrate" + (dark ? "" : " zu-light");
        var txt = (mode === "est" ? L("估 ", "est ") : "") + rate.toFixed(1) + L(" t/s", " t/s");
        var sig = mode + "|" + bandCls + "|" + cls + "|" + txt;
        if (!chip) {
          chip = document.createElement("span");
          chip.className = cls;
          chip.innerHTML = '<span class="' + bandCls + '">' + ttEsc(txt) + "</span>";
          chip.__zuSig = sig;
          var anchor = el.querySelector(".tool-summary-content") || el;
          try {
            if (anchor === el) el.appendChild(chip);
            else anchor.parentNode.insertBefore(chip, anchor.nextSibling);
          } catch (e) { continue; }
        } else if (chip.parentElement !== el) {
          try { el.appendChild(chip); } catch (e) { }
        }
        if (chip.__zuSig !== sig) {
          chip.__zuSig = sig;
          chip.className = cls;
          chip.innerHTML = '<span class="' + bandCls + '">' + ttEsc(txt) + "</span>";
        }
        chip.setAttribute("data-zusage-csid", csid);
        /* tooltip 数据包（buildTip 收包不收元素，见 subRowTipHTML 注释）：
         * showSubTip 以 el.__zuT.buildTip(el.__zuT) 调用，取数全走包内字段。 */
        chip.__zuT = { buildTip: subRowTipHTML, csid: csid, mode: mode,
                       rate: rate.toFixed(1), title: el.getAttribute("title") || "" };
      }
      if (subTipFor && subTipFor.isConnected && subTipFor.__zuT) showSubTip(subTipFor);   // 悬停中随推送刷新（签名幂等不重建）
      else if (subTipFor && !subTipFor.isConnected) hideSubTip();
    }
    /* ---------- 工作流 run 卡 chip（v332，specs/workflow-support.md）：会话流的宿主动态
     * 工作流卡片（[data-testid="workflow-card"]，data-workflow-run-id 携带 runId）注入
     * 运行汇总。数据双源：
     * ① 泵快照 sub.list 的 sess_dwf-<runId> 前缀行（完成态，每 ask 落库后随推送刷新）——
     *    run 级聚合速率按 tps_out/tps_gen 分量 Σout ÷ Σgen 加权（不能对各 tps_avg 直接
     *    平均）；旧快照缺分量字段时只显 token。
     * ② 卡 DOM 实时状态：data-workflow-card-state + 卡内 [data-agent-status] 计 running
     *    数（会话流内药丸不带 session id，只能提供 run 级计数）。
     * 悬停 tooltip 复用 subTip 浮层与 01 的委托监听（判定含 .zu-wfrun，不加新监听）；
     * 签名幂等、不持有 chip 引用，React 重建由 render 与 heavy（600ms）两处对账兜回。
     * 调用点=render 尾部与 compact 短路尾部（数据点）+ heavy（DOM 对账点），不上 100ms
     * 心跳（specs/perf-lag-reduction.md 热路径预算；状态点延迟 ≤600ms 属预期）。 */
    var WF_CARD_TID = "workflow-card";
    /* 按「已知 runId 集合」前缀匹配分组，不从 sid 反推 runId——runId 自身含 `-`
     * （dwfrun-<uuid>），取首个 `-` 会错切成 "dwfrun"；runId 以 DOM 卡的
     * data-workflow-run-id 为准（宿主同源值），sess_dwf-<runId>- 前缀匹配可靠。 */
    function wfRunsFromList(runIds) {
      var out = {}, list = (lastSub && lastSub.list) || [];
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it || !it.sid || String(it.sid).indexOf("sess_dwf-") !== 0) continue;
        for (var r = 0; r < runIds.length; r++) {
          if (String(it.sid).indexOf("sess_dwf-" + runIds[r] + "-") !== 0) continue;
          var g = out[runIds[r]];
          if (!g) g = out[runIds[r]] = { runId: runIds[r], total: 0, requests: 0, outSum: 0, genSum: 0, actors: [] };
          g.total += it.total || 0;
          g.requests += it.requests || 0;
          g.outSum += it.tps_out || 0;
          g.genSum += it.tps_gen || 0;
          g.actors.push(it);
          break;
        }
      }
      return out;
    }
    function wfRunStateOf(card) {
      var st = card.getAttribute("data-workflow-card-state") ||
               card.getAttribute("data-workflow-run-status") || "";
      var running = 0, pills = null;
      try { pills = card.querySelectorAll("[data-agent-status]"); } catch (e) { pills = null; }
      if (pills) {
        for (var i = 0; i < pills.length; i++) {
          if (String(pills[i].getAttribute("data-agent-status") || "") === "running") running++;
        }
      }
      return { state: st, running: running, pills: pills ? pills.length : 0 };
    }
    /* tooltip 构建器收包不收元素（同 subRowTipHTML 约定）：showSubTip 以
     * el.__zuT.buildTip(el.__zuT) 调用，取数全走包内字段。 */
    function wfRunTipHTML(t) {
      var out = "<style>" +
        '.zusage-wfrun-tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px;overflow-wrap:anywhere}' +
        '.zusage-wfrun-tip .rt-row{display:flex;gap:12px;margin:4px 0;align-items:flex-start}' +
        '.zusage-wfrun-tip .rt-row b{flex:0 0 86px;min-width:0;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500}' +
        '.zusage-wfrun-tip .rt-row span{min-width:0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}' +
        ".zusage-wfrun-tip .wf-actor{display:flex;gap:8px;margin:3px 0;font-size:.92em;align-items:baseline}" +
        ".zusage-wfrun-tip .wf-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".zusage-wfrun-tip .wf-num{flex:0 0 auto;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-variant-numeric:tabular-nums}" +
        "</style>";
      out += '<div class="rt-h">' + ttEsc(L("工作流", "Workflow")) + ' <span class="sub-agent">' + ttEsc(t.runShort) + "</span></div>";
      var stText = t.running > 0 ? L("运行中 · ", "running · ") + t.running + L(" 个执行中", " active")
        : (t.state || L("未知", "unknown"));   // 原文进 ttRow 由其统一转义（v334：去内层 ttEsc 防双重转义）
      out += ttRow(L("状态", "State"), stText);
      out += ttRow(L("Token 合计", "Tokens"), fmt(t.total));
      if (t.rate != null) {
        out += ttRow(L("聚合速率", "Aggregate rate"), t.rate + L(" t/s", " t/s"));
        out += ttRow(L("口径", "Basis"), L("已完成段加权平均（Σ输出 ÷ Σ生成耗时）；运行中部分完成后计入",
          "Completed-segment weighted average; in-flight asks count in as they settle"));
      }
      out += ttRow(L("请求数", "Requests"), t.requests + L(" 次", " requests"));
      if (t.actors && t.actors.length) {
        out += '<div class="rt-row"><b>' + ttEsc(L("执行者", "Actors")) + "</b><span>";
        for (var i = 0; i < t.actors.length; i++) {
          var a = t.actors[i];
          out += '<div class="wf-actor"><span class="wf-name">' + ttEsc(a.name) + "</span>" +
            '<span class="wf-num">' + fmt(a.total) + (a.tps != null ? " · " + a.tps + L(" t/s", " t/s") : "") + "</span></div>";
        }
        out += "</span></div>";
      }
      return out;
    }
    function renderWorkflowCards() {
      if (inactive()) return;
      if (!(composer && composer.isConnected) && !(wantedEl && wantedEl.isConnected)) return;
      var rootEl = subRowPaneRoot();
      if (!rootEl) return;
      /* ⚙「工作流卡汇总」门（同 subRate 门语义）：关闭即摘净本 pane chip 并收起悬停浮层，
       * 重开由 render/heavy 对账自然重建。 */
      if (!state.show.wfChip) {
        var staleWf = rootEl.querySelectorAll(".zu-wfrun");
        for (var wc = 0; wc < staleWf.length; wc++) { try { staleWf[wc].remove(); } catch (e) { } }
        if (subTipFor && subTipFor.classList && subTipFor.classList.contains("zu-wfrun")) hideSubTip();
        return;
      }
      var cards;
      try { cards = rootEl.querySelectorAll('[data-testid="' + WF_CARD_TID + '"]'); } catch (e) { return; }
      if (!cards.length) return;
      /* 摘除单卡旧 chip（v334）：run 失败/取消且无任何 ask 落库、或宿主摘掉状态属性后，
       * 不满足渲染条件的卡不再保留上一拍的「运行中」残留。 */
      var wfChipStale = function (card0) {
        var old = card0.querySelector(".zu-wfrun");
        if (old) { try { old.remove(); } catch (e) { } }
      };
      var runIds = [];
      for (var rc = 0; rc < cards.length; rc++) {
        var rid0 = String(cards[rc].getAttribute("data-workflow-run-id") || "");
        if (rid0) runIds.push(rid0);
        else wfChipStale(cards[rc]);   // v335：runId 被宿主剥掉同样算不满足条件，摘残留（空 runIds 早退前执行）
      }
      if (!runIds.length) return;
      var runs = wfRunsFromList(runIds);
      var dark = true;
      try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
      for (var c = 0; c < cards.length; c++) {
        var card = cards[c];
        var runId = String(card.getAttribute("data-workflow-run-id") || "");
        if (!runId) { wfChipStale(card); continue; }
        var dom = wfRunStateOf(card);
        if (!dom.state && !dom.pills) { wfChipStale(card); continue; }   // 无状态属性的卡不认（防宿主同名 testid 漂移出别物；全缺与它重合，不单列）
        var g = runs[runId] || { runId: runId, total: 0, requests: 0, outSum: 0, genSum: 0, actors: [] };
        var rate = g.genSum > 0 ? g.outSum * 1000 / g.genSum : null;   // tps_gen 分量是毫秒（同 _rated_tps：Σout ÷ (Σgen/1000)）
        var bandCls = "ok", parts = [];
        if (g.total > 0) parts.push(fmt(g.total));
        if (rate != null) {
          bandCls = (tpsBand(rate) || { cls: "ok" }).cls;
          parts.push(rate.toFixed(1) + L(" t/s", " t/s"));
        }
        if (!parts.length && dom.running > 0) parts.push(L("运行中", "running"));
        if (!parts.length) { wfChipStale(card); continue; }   // 无 token、无速率、也不在跑：摘旧 chip
        var txt = parts.join(L(" · ", " · "));
        var cls = "zu-wfrun" + (dark ? "" : " zu-light");
        var sig = bandCls + "|" + cls + "|" + txt + "|" + dom.state + "|" + dom.running;
        var chip = card.querySelector(".zu-wfrun");
        if (!chip) {
          chip = document.createElement("span");
          chip.className = cls;
          chip.__zuSig = "";
          var anchor0 = card.querySelector(".workflow-card-status");
          try {
            if (anchor0) anchor0.parentNode.insertBefore(chip, anchor0.nextSibling);
            else card.appendChild(chip);
          } catch (e) { continue; }
        }
        if (chip.__zuSig !== sig) {
          chip.__zuSig = sig;
          chip.className = cls;
          chip.innerHTML = '<span class="' + bandCls + '">' + ttEsc(txt) + "</span>";
        }
        /* tooltip 包每拍重写（v334）：requests/actor 名只进包不进 sig——ask 空结算或
         * 任务名后补时保持「打开瞬间内容最新」（specs/perf-lag-reduction.md §1）。 */
        var actors = [];
        for (var ai = 0; ai < g.actors.length; ai++) {
          var a0 = g.actors[ai];
          actors.push({ name: (String(a0.task || "").trim() || String(a0.title || "").trim() || String(a0.sid || "").slice(-6)),
                        total: a0.total || 0, tps: (a0.tps_avg > 0 ? a0.tps_avg.toFixed(1) : null) });
        }
        chip.__zuT = { buildTip: wfRunTipHTML, runId: runId, runShort: runId.slice(-12), state: dom.state,
                       running: dom.running, total: g.total, requests: g.requests,
                       rate: (rate != null ? rate.toFixed(1) : null), actors: actors };
      }
      if (subTipFor && subTipFor.isConnected && subTipFor.__zuT) showSubTip(subTipFor);   // 悬停中随推送刷新（签名幂等不重建）
      else if (subTipFor && !subTipFor.isConnected) hideSubTip();
    }
    /* 心跳读快照（issue #309，specs/perf-lag-reduction.md 规则 10）：100ms 心跳不得对桥包装
     * getState()——桥 v2 每次读都是整窗深拷贝（O(window)：本机 374 行 ≈1ms，报告者 6868 行 ≈86ms；
     * 心跳每拍读两次就把主线程占满）。通知回调已把最新快照记在 handle 上（snap/snapAt），心跳路径的
     * 消费方（bridgeTick 健康检查、subRunningList、「思考中」合成）都读这份记录。记录超过
     * SNAP_FRESH_MS 无更新才回源 getState() 一次并回写——这次回源兼作 store 关闭/换代的探活
     * （读到 null 或 sessionId 变，调用方按既有语义脱离重绑）；pane 切会话由 handle.sid/sideKey
     * 与当前会话的比对即时重绑，不靠探活。age<0（系统时钟回拨）按陈旧处理，不让记录永远「新鲜」。 */
    var SNAP_FRESH_MS = 2000;
    function handleSnapshot(h) {
      if (!h || h.dead || !h.store) return null;
      var now = Date.now();
      if (typeof h.snapAt === "number") {
        var age = now - h.snapAt;
        if (age >= 0 && age < SNAP_FRESH_MS) return h.snap || null;
      }
      var snap = null;
      try { var st = h.store.getState(); snap = (st && st.snapshot) || null; } catch (e) { snap = null; }
      h.snap = snap;
      h.snapAt = now;
      return snap;
    }
    /* ---------- 运行中子代理集合补给（v333，specs/agent-background-support.md）：
     * rows 行（turn-stats 透传，父会话尾部 60 行窗口内）∪ 桥快照 backgroundWorks 的
     * 后台智能体条目——后台运行中用户继续对话会把启动行滚出窗口，backgroundWorks
     * 是事件驱动 state 键、窗口无关（kind 闭集 bash|subagent|workflow，status 闭集
     * running|resultPending|failed|cancelled，resultPending=已完成不计）；条目投递后
     * 消失，由既有对账自然解绑槽位。snapshot.subagents.running 与 rows 同窗口派生，
     * 不作补给源。 */
    function subRunningList(stats) {
      var list = (stats && !stats.complete && Array.isArray(stats.runningSubagents)) ? stats.runningSubagents.slice() : [];
      var h = bridge.handle;
      if (!h || h.dead || !h.store) return list;
      var snap = handleSnapshot(h);   // issue #309：读通知回调记下的快照，不在 100ms 心跳里 getState()
      /* 会话校验（v334）：pane 原地切会话后、bridgeTick 重绑前的一拍内不得并入上一
       * 会话的后台任务清单（同函数族既有的 snap.sessionId 校验纪律）。 */
      if (!snap || snap.sessionId !== h.sid) return list;
      var works = snap.backgroundWorks;
      if (!Array.isArray(works)) return list;
      for (var i = 0; i < works.length; i++) {
        var w = works[i];
        if (w && w.kind === "subagent" && w.status === "running" &&
            typeof w.childSessionId === "string" && w.childSessionId) {
          var dup = false;
          for (var j = 0; j < list.length; j++) if (list[j] && list[j].childSessionId === w.childSessionId) { dup = true; break; }
          if (!dup) list.push({ childSessionId: w.childSessionId });
        }
      }
      return list;
    }
    /* ---------- 状态面板 Agents 行速率 chip（v333，specs/agent-background-support.md）：
     * 宿主状态面板 Agents 分区行（v4-running-subagent-item + data-child-session-id，
     * e2e 锁定）是后台智能体的主要运行态 UI，宿主只有 elapsed 计时无用量。行内注入
     * .zu-substat（独立类名：不被 subRate 门的摘净选择器误伤，但同受 state.show.subRate
     * 门控）——槽位估算（3s 内）→「估 X t/s」；槽位在但无字符流 →「估算中…」；无槽位
     * → sub.list tps_avg 回填 →「X t/s」；全缺 →「运行中」。tooltip 复用 subRowTipHTML
     * 数据包与 subTip 浮层（01 委托判定含 .zu-substat）。调用点=render 尾部 + heavy
     * （600ms 对账），不上 100ms 心跳（热路径预算）。锚点为宿主内部 testid，漂移时
     * 零命中 no-op。 */
    function renderRunningSubagentItems() {
      if (inactive()) return;
      if (!(composer && composer.isConnected) && !(wantedEl && wantedEl.isConnected)) return;
      var rootEl = subRowPaneRoot();
      if (!rootEl) return;
      if (!state.show.subRate) {   // 子代理速率族共用开关：关即摘净并收起本 pane 悬停浮层
        var staleStat = rootEl.querySelectorAll(".zu-substat");
        for (var sc = 0; sc < staleStat.length; sc++) { try { staleStat[sc].remove(); } catch (e) { } }
        if (subTipFor && subTipFor.classList && subTipFor.classList.contains("zu-substat")) hideSubTip();
        return;
      }
      var now = Date.now(), list = (lastSub && lastSub.list) || [], bySid = {};
      for (var li = 0; li < list.length; li++) if (list[li] && list[li].sid) bySid[list[li].sid] = list[li];
      var rows;
      try { rows = rootEl.querySelectorAll('[data-testid="v4-running-subagent-item"]'); } catch (e) { return; }
      var dark = true;
      try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
      for (var r = 0; r < rows.length; r++) {
        var el = rows[r];
        var csid = String(el.getAttribute("data-child-session-id") || "");
        if (!csid) continue;
        var sl = subRate.slots[csid];
        var rate = (sl && sl.rate != null && now - sl.at <= 3000) ? sl.rate : null;
        var bandCls = "ok", txt, mode = "est";
        if (rate != null) {
          var band = tpsBand(rate);
          bandCls = band ? band.cls : "ok";
          txt = L("估 ", "est ") + rate.toFixed(1) + L(" t/s", " t/s");
        } else if (bySid[csid] && bySid[csid].tps_avg > 0) {
          rate = bySid[csid].tps_avg;   // 转场瞬间（行还在、槽位刚解绑）回填真实均速
          bandCls = (tpsBand(rate) || { cls: "ok" }).cls;
          txt = rate.toFixed(1) + L(" t/s", " t/s");
          mode = "real";
        } else if (sl) {
          bandCls = "dim";   // 绑定中/思考期：无字符流不显估算，估速口径仍适用（等待字符流）
          txt = L("估算中…", "estimating…");
        } else {
          bandCls = "dim";
          txt = L("运行中", "running");
          mode = "run";   // v334：无槽位无数据，既无估算也无将来的估算，tooltip 不挂估速口径
        }
        var chip = el.querySelector(".zu-substat");
        var cls = "zu-substat" + (dark ? "" : " zu-light");
        var sig = mode + "|" + bandCls + "|" + cls + "|" + txt;
        if (!chip) {
          chip = document.createElement("span");
          chip.className = cls;
          chip.__zuSig = "";   // 置空走下方内容分支首建即写（预设 sig 会跳过 innerHTML，chip 恒空白）
          try { el.appendChild(chip); } catch (e) { continue; }
        } else if (chip.parentElement !== el) {
          /* v334：宿主结构变更可能把 chip 裹进更深容器——回位到行直接子节点，保住
           * margin-left:auto 靠右定位（renderSubAgentRows 同款守卫）。 */
          try { el.appendChild(chip); } catch (e) { }
        }
        if (chip.__zuSig !== sig) {
          chip.__zuSig = sig;
          chip.className = cls;
          chip.innerHTML = '<span class="' + bandCls + '">' + ttEsc(txt) + "</span>";
        }
        chip.setAttribute("data-zusage-csid", csid);
        chip.__zuT = { buildTip: subRowTipHTML, csid: csid, mode: mode,
                       rate: (rate != null ? rate.toFixed(1) : ""), title: el.getAttribute("title") || "" };
      }
      if (subTipFor && subTipFor.isConnected && subTipFor.__zuT) showSubTip(subTipFor);   // 悬停中随推送刷新（签名幂等不重建）
      else if (subTipFor && !subTipFor.isConnected) hideSubTip();
    }
    /* ---------- 主格子代理运行态合成（v336，specs/agent-background-support.md §3）：
     * 后台智能体经 backgroundWorks 补给进槽位后，主会话自身无实时轮（空闲/上一轮已
     * 完成）时速度格仍静态显示会话均——合成 runningTool=Agent 态让 zuBarSpeedView 走
     * 既有子代理分支（「子代理运行中 · 估 X t/s」×N，槽位有估算时；绑定中/思考期
     * 降级为状态词），后台全部结束（槽位解绑）自动回落会话均。主会话自己的轮在跑
     * 时优先返回原 stats（v87 合成分支先行、工具/正文态不被覆盖）。 */
    function synthesizeBackgroundStats(stats) {
      if (stats && !stats.complete) return stats;
      var want = [];
      for (var sid in subRate.slots) {
        if (subRate.slots[sid] && subRate.slots[sid].want) want.push({ childSessionId: sid });
      }
      if (!want.length) return stats;
      return {
        complete: false, characterRate: null,
        runningTool: { name: "Agent", startedAt: null,
                       childSessionId: want[want.length - 1].childSessionId },
        phase: "tool", observedMs: 0, observedLive: true, totalCharacters: 0,
        runningSubagents: want,
      };
    }
    /* 每次主桥数据到达时 reconcile：不在 runningSubagents 里的槽位解绑，新出现的
     * 尝试绑定（槽位级 2s 节流——updateLive 挂在 0.1s 心跳上，不节流会让 diag 全表
     * 枚举跟着心跳空转）。 */
    function subRateTick(runningSubagents) {
      var list = [];
      if (runningSubagents) {
        /* turn-stats 按 rowId 升序给出（最早在前）；超上限时从尾部取，保住的是
         * 最新派发的 8 个（v180 review 修正：旧实现取头部=最早派发，与注释相反） */
        for (var i = runningSubagents.length - 1; i >= 0 && list.length < MAX_SUB_SLOTS; i--) {
          var cs = runningSubagents[i] && runningSubagents[i].childSessionId;
          if (cs && list.indexOf(cs) < 0) list.push(cs);
        }
      }
      for (var sid in subRate.slots) if (list.indexOf(sid) < 0) subSlotDetach(sid);
      for (var j = 0; j < list.length; j++) {
        if (!subRate.slots[list[j]]) {
          subRate.slots[list[j]] = { handle: null, store: null, tracker: null, off: null,
                                     rate: null, at: 0, calib: null, retryAt: 0, want: list[j], st: "" };
        }
        subTryBindSlot(subRate.slots[list[j]]);
      }
      subRateRecompute();
      /* v179 定位诊断：原地写字段（对象不换引用），随 ~15 次泵拉取落 diag-*.json。
       * 绑定与否按 handle 判（v180 review：reset 重试窗口的槽位残留旧 st 会把
       * 已解绑槽位计成 bound/rate），未绑定槽位一律入 noStore 桶。 */
      var dBound = 0, dRate = 0, dThink = 0, dCalib = 0, dNo = 0;
      for (var dKey in subRate.slots) {
        var dSl = subRate.slots[dKey];
        if (!dSl.handle) { dNo++; continue; }
        dBound++;
        if (dSl.st === "rate") dRate++;
        else if (dSl.st === "thinking") dThink++;
        else if (dSl.st === "calib") dCalib++;
      }
      SUBRATE_DIAG.want = list.length;
      SUBRATE_DIAG.bound = dBound;
      SUBRATE_DIAG.rate = dRate;
      SUBRATE_DIAG.think = dThink;
      SUBRATE_DIAG.calib = dCalib;
      SUBRATE_DIAG.noStore = dNo;
      SUBRATE_DIAG.acqFn = typeof window.__zusageAcquireConversationStore === "function" ? 1 : 0;
      SUBRATE_DIAG.t = Date.now();
    }
    function subTryBindSlot(sl) {
      if (sl.handle || Date.now() < sl.retryAt) return;
      var store = zuTryBindStore(sl.want);
      if (store) {
        sl.st = "bound";
      } else {
        /* v179：后台运行子代理在宿主注册表里没有现成 store（目录面板不下钻不订阅，
         * T2 上线以来运行期估算从未真正工作过的根因）。桥 v2 提供
         * __zusageAcquireConversationStore：按本 pane 已验证 scope 的父工作区
         * acquire 子会话租约（同下钻路径，refcount 计数、off 时 release）。
         * 仅 sess_subagent_ 前缀 + 本地会话；桥未升级（v1）时为 null，退回 2s 重试。 */
        var scope = readPaneScope(wantedEl, pickedSid || instSid, pid);
        if (scope && !scope.remoteSessionId) store = zuAcquireSubStore(sl.want, scope);
        if (!store) {
          sl.st = "noStore";
          sl.retryAt = Date.now() + 2000;
          return;   // 注册表里还没有该 topic 且不可 acquire：2s 后再试
        }
        sl.st = "acquired";
      }
      var h = { dead: false, sid: sl.want };
      var tracker = TURN_STATS.createTracker();
      sl.handle = h; sl.store = store; sl.tracker = tracker;
      var offFn = TURN_STATS.subscribeStore(store, tracker, function () {
        if (inactive() || h.dead) { subSlotReset(sl); subRateRecompute(); return; }
        var st = null;
        try { st = store.getState(); } catch (e) { st = null; }
        var snap = st && st.snapshot;
        if (!snap || snap.sessionId !== sl.want) { subSlotReset(sl); subRateRecompute(); return; }   // 关闭/换代：重置待重试
        var tid = zuActiveTurnId(snap);
        var stats = tid ? tracker.get(tid) : null;
        if (stats && !stats.complete) {
          if (stats.characterRate != null) {
            sl.rate = stats.characterRate /
              (sl.calib || (bridge.handle && bridge.handle.charsPerToken) || DEFAULT_CHARS_PER_TOKEN);
            sl.at = Date.now();
            sl.st = "rate";
          } else {
            sl.rate = null;   // 思考期无可测字符流：该槽位缺席合计
            sl.st = "thinking";
          }
        } else if (stats && stats.complete && stats.outputTokens > 0 && stats.totalCharacters > 0) {
          sl.calib = stats.totalCharacters / stats.outputTokens;   // c2t 自校准：该子代理完成轮的真实比例
          sl.st = "calib";
        }
        subRateRecompute();
        /* 回调跑在宿主 store 的通知分发里，异常会冒进宿主其它订阅者（泵入口对 render 同款包裹） */
        try { updateLive(); } catch (e) { FATAL.subLiveErr = String((e && e.stack) || e); }
      });
      sl.off = offFn;
      /* subscribeStore 会同步首调一次回调：首调即 reset（换代/sessionId 不匹配）时
       * h.dead 已置位，offFn 是悬挂订阅的解绑函数——直接判 offFn 会把它当成功绑定
       * 写回（10Hz 重绑抖动 + 订阅泄漏，review P1）。按 h.dead 判定：显式释放 offFn
       * （幂等，兼带 dispose tracker），subSlotReset 自带 2s 节流防心跳空转。 */
      if (!offFn || h.dead) {
        if (offFn) { try { offFn(); } catch (e) { } }
        subSlotReset(sl);
      }
    }
    function sideHandleValid(handle) {
      if (!handle || handle.dead) return false;
      var sid = instSid || pickedSid || "";
      if (handle.sideKey === null) return sid === handle.sid;   // v174：主分栏也校验会话——切会话后、下次 bridgeTick 重绑前不得读旧 tracker
      var scope = readPaneScope(wantedEl, sid, pid);
      var key = scope && JSON.stringify([scope.sid, scope.identity, scope.workspacePath, scope.remoteSessionId]);
      return sid === handle.sid && key === handle.sideKey;
    }
    function bridgeTick() {
      if (inactive()) return;
      if (!state.rateLine || !TURN_STATS) { bridgeDetach(bridge.handle); updateLive(); return; }
      var sid = instSid || pickedSid || "";
      if (!sid) { bridgeDetach(bridge.handle); updateLive(); return; }
      /* v174：辅助对话实例必须有可信 scope（桥属性在位且校验通过）才绑 store——registry
       * 按 (remote, workspace) 精确匹配，匹配不到就保持 DB 降级；无 scope 时不猜归属。 */
      var sideScope = null;
      if (String(pid).indexOf("selection-side-chat:") === 0) {
        /* pickedSid 在首轮 render 前可能滞后（bootstrap 窗口），回退 instSid 与 heavy 同语义 */
        sideScope = readPaneScope(wantedEl, pickedSid || instSid, pid);
        if (!sideScope || sideScope.identity !== "" || sideScope.remoteSessionId !== "") {
          bridgeDetach(bridge.handle); updateLive(); return;
        }
      }
      var sideKey = sideScope ? JSON.stringify([sideScope.sid, sideScope.identity, sideScope.workspacePath, sideScope.remoteSessionId]) : null;
      if (bridge.handle) {
        if (bridge.handle.sid === sid && bridge.handle.sideKey === sideKey) {
          /* issue #309：健康检查读 handle 上的快照记录（handleSnapshot：≤2s 回源一次兼作探活），
           * 100ms 心跳不再每拍 getState()。 */
          var snap = handleSnapshot(bridge.handle);
          /* 绑定健康：store 可能在工具执行期间（查阅/编辑等）很久不推新快照——
           * 仍按本轮 2s 心跳刷新一次，让「已观察 Xs」能继续走字，而不是整段
           * 工具执行时间里界面像冻住；updateLive 内部按文本/类名是否真变化
           * 做了去重写入，这里多调用一次不会造成多余的 DOM 抖动。 */
          if (snap && snap.sessionId === bridge.handle.sid) { updateLive(); return; }
        }
        bridgeDetach(bridge.handle);   // pane 切会话 / store 关闭或换代：释放后重绑
      }
      var store = zuTryBindStore(sid, sideScope && {
        identity: sideScope.identity, workspacePath: sideScope.workspacePath, remoteSessionId: sideScope.remoteSessionId,
      });
      if (!store) { updateLive(); return; }   // 无桥 / 无匹配 session：降级（DB 路径不变），下轮再探
      var tracker = TURN_STATS.createTracker();
      var handle = { dead: false, sid: sid, sideKey: sideKey, store: store, tracker: tracker, alias: {}, off: null, charsPerToken: null, bornAt: Date.now(), snap: null, snapAt: null };
      var off = TURN_STATS.subscribeStore(store, tracker, function (st) {
        if (inactive() || handle.dead) return;
        if (!sideHandleValid(handle)) { bridgeDetach(handle); updateLive(); return; }
        /* issue #309：st 是 subscribeStore 本次通知已读的 state（桥 v2 每读一次 = 一份整窗深拷贝），
         * 直接用，不再 getState()；同时记到 handle 上供 100ms 心跳消费（handleSnapshot）。 */
        var snap = st && st.snapshot;
        if (!snap || snap.sessionId !== sid) { bridgeDetach(handle); updateLive(); return; }   // 换代/关闭：下轮 tick 重绑
        handle.snap = snap;
        handle.snapAt = Date.now();
        var rows = snap.rows && snap.rows.window;
        if (Array.isArray(rows)) {
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (r && typeof r.turnId === "string") handle.alias[r.turnId] = r.productTurnId || r.turnId;
          }
        }
        bridge.turnId = zuActiveTurnId(snap);
        /* 同上：宿主 store 通知分发内的回调不留异常出口 */
        try { updateLive(); } catch (e) { FATAL.bridgeLiveErr = String((e && e.stack) || e); }
      });
      if (!off) {   // store 接口不合约定：退回降级
        try { store.off(); } catch (e) { }
        tracker.dispose();
        updateLive();
        return;
      }
      /* 首次同步回调可能已解绑；此时 off 尚未保存，必须释放悬挂订阅。 */
      if (handle.dead) { try { off(); } catch (e) { } updateLive(); return; }
      handle.off = off;
      bridge.handle = handle;
      bridge.rebinds = (bridge.rebinds || 0) + 1;   // 诊断：本 pane 实例绑定/重绑次数
      updateLive();   // subscribeStore 首次同步回调已 ingest 初始快照，这里补挂实时段
    }
    function updateLive() {
      /* v73：合并「生成速度」chip 后，桥数据持续存在（生成中→完成，同一套
       * ico+'<span class="zu-live CLS">'+TEXT 结构）时只原地改 textContent/className，
       * 不重建条面（v33 原则）；桥「有/无」切换才会改变 chip 结构（图标出现/消失、
       * 退回 DB 的两段式拼接），需要整条重渲染。 */
      var h = bridge.handle;
      if (h && !sideHandleValid(h)) { bridgeDetach(h); h = null; }
      var stats = (state.rateLine && h && !h.dead && bridge.turnId) ? h.tracker.get(bridge.turnId) : null;
      /* v87：绑定成功但 turnHeader 还没到——桥活着就别让 chip 空着，按绑定时长合成
       * "思考中"，turnHeader 到位后自然切换为真实统计。v116 条件按宿主源码收紧：
       * ① control.phase==="running"（verifier/长轮 header 滑出，轮真的在跑）；
       * ② 显式 phase==="draft" 且窗口为空（新会话空窗，v87 本意）。宿主 wire 快照
       * rows.window 恒为全序尾 60 行（PROTOCOL_V4_LIMITS.snapshotTailWindowRows），
       * 末轮行数超窗口的闲置会话整窗没有 turnHeader——旧条件「行非空」会让这类会话
       * 永久合成"思考中"（用户停了任务还亮着、切走切回每次重绑重新计时）；而
       * phase=running 与 turnHeader 行同批到达，「行非空且非 running」不存在合法瞬态。
       * control 缺失或 phase 未知的旧形状一律不合成（字段缺失是常态不是错误）。 */
      if (!stats && h && !h.dead && bridge.handle && h.store) {
        try {
          var snap0 = handleSnapshot(h);   // issue #309：读快照记录，不在 100ms 心跳里 getState()
          if (snap0 && snap0.sessionId === h.sid) {
            var rows0 = snap0.rows && snap0.rows.window;
            var ph0 = snap0.control && snap0.control.phase;
            if (ph0 === "running" || (ph0 === "draft" && rows0 && !rows0.length)) {
              stats = { complete: false, characterRate: null, runningTool: null,
                        phase: "thinking", observedMs: Math.max(0, Date.now() - (h.bornAt || Date.now())),
                        observedLive: true, totalCharacters: 0 };
              bridge.turnId = bridge.turnId || "";
            }
          }
        } catch (e) { }
      }
      if (h && stats && stats.complete && stats.outputTokens > 0 && stats.totalCharacters > 0) {
        h.charsPerToken = stats.totalCharacters / stats.outputTokens;   // c2t 自校准：本轮真实比例供下一轮估算用
      }
      subRateTick(subRunningList(stats));   // 运行中子代理逐个绑/解速率桥（v333：∪ backgroundWorks 补给，窗口滚出不丢）
      stats = synthesizeBackgroundStats(stats);   // v336：主会话无实时轮而后台槽位在跑——合成子代理运行态（速度格不再静态）
      renderSubAgentRows();   // v176：Agent 行内速率 chip 对账（槽位估算/快照真实值两态）
      var wasLive = liveKindCur === "live";
      var view = stats ? zuBarSpeedView(stats, h && h.charsPerToken, subRate.sum,
        /* 本 pane 会话行（render 缓存），不取 payload 顶层 session——那是全局最近活跃
         * 会话，多窗/分栏下会把别的会话的会话均串进本格（v181 补修）。 */
        (lastView && lastView.session && typeof lastView.session.avg_tps === "number" &&
         isFinite(lastView.session.avg_tps) && lastView.session.avg_tps > 0) ? lastView.session.avg_tps : 0) : null;
      liveStatsCur = stats;
      if (state.theme === "compact") { syncTpsChip(); return; }   // v146：精简模式速率走工具行 chip（10Hz 心跳原地跟随，条面不重建）
      // 用 view（而非 stats）判定快速路径：stats 非空但 view 为 null（历史存量，见
      // zuBarSpeedView）时结构要切回降级拼法，必须走下面的整条重渲染，不能原地改字。
      // 阶段（思考↔工具↔正文）切换会更换 chip 的图标（动效脑/闪电），同样只能整条
      // 重渲染——原地改字换不了图标。
      var phase = view && view.phase ? view.phase : "";
      if (view && wasLive && phase === livePhaseCur) {
        liveTextCur = view.text;
        if (!liveEl) { render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 }); return; }
        /* v326：原地更新同样写「数字+dim」两 item 结构（gap:5px 需两 item；textContent
         * 会把结构转义成纯文本）。innerHTML 小串无压力，相位切换仍走整条重渲染。 */
        var faceHtml = zuLiveFaceHtml(view.text);
        if (liveEl.innerHTML !== faceHtml) liveEl.innerHTML = faceHtml;
        liveIconCur = phase === "thinking" ? "think" : phase === "tool" ? "tool" : phase ? "generate" : "bolt";
        var cls = "zu-live " + view.cls + (view.word ? " zu-shimmer" : "");
        if (liveEl.className !== cls) liveEl.className = cls;
        /* v97：子代理速率是渲染端实时状态（不在泵快照里），tooltip 里的逐子代理
         * 行随原地改字一起刷新——内容签名没变时 drawTip 幂等只调位置，不闪烁。
         * 性能治理（specs/perf-lag-reduction.md §4）：未悬停本格时不再每拍白建整张 V2 速度卡
         * （心跳 10Hz + store 通知，6000 轮历史时 ~5ms/次）——只记最新 view 并标失鲜，
         * drawTip 打开瞬间经 liveTipRefresh 补建，兜底每 1s 保鲜一次；悬停本格仍每拍构建。 */
        var liveCell = liveEl.closest ? liveEl.closest(".it") : null;
        var hoverLive = !!liveCell && typeof tipFor !== "undefined" && tipFor === liveCell;
        if (liveCell && !hoverLive && Date.now() - liveTipBuiltAt < 1000) {
          liveCell.__zuTipView = view;
          liveCell.__zuTipStale = true;
          return;
        }
        liveTipBuiltAt = Date.now();
        var tip1 = buildLiveTip(view);
        if (liveCell) liveCell.__zuTipStale = false;
        if (liveCell && liveCell.__tip !== tip1) {
          /* v224 修复：__tip 宿主与 drawTip 读取都在 .it 格元素上（render 挂 tips[i]、
           * drawTip 读 tipFor.__tip）——v218 只改了 tipFor 判定，新串仍写到格内
           * .zu-live span：条件每 tick 命中、重画的却始终是整条渲染时挂在格上的旧串，
           * 悬停中「当前读数」冻结在最后一次整条渲染的值（实测 chip 已跳动、tooltip
           * 还停在「思考中…2秒」）。改写回格元素：悬停中每 tick 跟手，未悬停也新鲜。
           * v232：键盘焦点在柱状图柱上时只保鲜 __tip 不重画（innerHTML 换掉聚焦柱会
           * 丢焦点），焦点移出后下一 tick 恢复跟手；ownerDocument 取 activeElement，
           * 不引用全局 document（updateLive 切片沙箱无 document）。 */
          liveCell.__tip = tip1;
          var aeDoc = liveCell.ownerDocument;
          var ae = aeDoc ? aeDoc.activeElement : null;
          /* v254：V2 双 Tab / 维度下拉 / 柱 hover 交互后短冻结 600ms——updateLive 每
           * 100ms 重编整卡会打断下拉展开、Tab 点击与柱间平滑切换（焦点不在 tip 内时
           * 现有守卫不覆盖）。冻结期只保鲜 __tip 不重画，退出后下一 tick 自然跟手。
           * v263：悬停保活（mouseInBar）同样冻结——生成中估算/思考计时走字让 tipSig
           * 每 tick 变化、innerHTML 整卡重建，不仅打断交互（Tab 已提前到 pointerdown
           * 兜底），悬停中整卡每秒重绘也闪烁。指针停在 tooltip 上时数字冻结在进入
           * 时刻，离开后下一 tick 恢复跟手。 */
          var v2Freeze = (typeof speedInteractAt !== "undefined" && speedInteractAt &&
            Date.now() - speedInteractAt < 600) ||
            (typeof mouseInBar !== "undefined" && mouseInBar);
          /* v291：热力图格子（.zu-hm-cell）同样 tabindex 可聚焦，键盘焦点落在格内时
           * 与柱体同守卫——innerHTML 重建会销毁聚焦格（焦点跌落 body、Tab 序断裂） */
          if (tipFor === liveCell && !v2Freeze && !(ae && ae.closest && ae.closest(".zu-sc-col,.zu-hm-cell"))) drawTip(liveCell, true);
        }
        return;
      }
      liveTextCur = view ? view.text : "";
      /* 性能治理（specs/perf-lag-reduction.md §6）：非 live（view 为 null，历史/空闲会话）且数据帧引用
       * 未变时，100ms 心跳不重复整条 render——html() 急切构建全部 tooltip 串 + 五个 enhance* 全文档查询，
       * 单次约 8~20ms，v90「空转无性能顾虑」的前提（只比较不写 DOM）并不成立。数据帧变化、live↔非 live
       * 切换、设置/主题变化（直调 render）仍即时；500ms 兜底与 heavy(600ms) 同量级。 */
      if (!view && !wasLive && idleRenderData === state.data && Date.now() - idleRenderAt < 500) return;
      idleRenderData = state.data;
      idleRenderAt = Date.now();
      render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 });
    }
    var liveTipBuiltAt = -Infinity, idleRenderData = null, idleRenderAt = -Infinity;   // 实例级节流状态（updateLive 切片内声明，VM 夹具同源；初值 -Infinity：首拍恒构建/渲染，不依赖时钟绝对值）
    /* v90：心跳 0.5s→0.1s——0.5s 秒数走字仍有可感卡顿；render 有 lastHtml 幂等守卫，
     * 内容未变时仅字符串构建+比较、不写 DOM，10Hz 空转无性能顾虑。扫描 tick 保持 0.5s。 */
    bridge.timer = setInterval(bridgeTick, 100);
    bridgeTick();

    function render(d) {
      /* v262：只有真实快照帧才更新共享数据。空对象兜底渲染（实例 spawn 首渲染/桥空窗的
       * `render(state.data || {session:{},...})`）若覆盖 state.data，会把统一轮表连同整帧
       * 抹掉——下一次 hover 的整条渲染读不到 speed_history，走 fb-html 旧版整卡（v261
       * spdRender 实证 hasH:false，正是「老会话旧卡、新会话正常」的根因）。真帧自有
       * __zusageUpdate 外层写入，这里条件写只防回退，渲染本身仍按入参 d 照常执行。 */
      if (d && d.session && d.session.sid) state.data = d;
      var pc = null, p = null;
      if (instSid) {
        /* v61.1 分屏多实例：本条显示哪个会话由 composer 祖先链的 data-session-id 决定
         * （客户端每个 pane 自带该标记，比窗口级 mine 更准，绝不串 pane）；
         * 会话不在池里（还没拉取）就显示本会话 0 值 —— 绝不回退到别的会话（v34 原则）。 */
        pickedSid = instSid;
        p = sessionFor(d, instSid, pid);
        if (!p) p = stubFor(instSid);
      } else if (String(pid).indexOf("selection-side-chat:") === 0) {
        /* v174：辅助对话无可信 child sid（宿主缺 data-session-id 标记的窗口期）时，
         * 绝不借窗口焦点（mine）或最近会话（pickCurrent）——身份未知显示空 stub，
         * 等协调器补上会话标记后自然恢复。 */
        pickedSid = "";
        p = stubFor("");
      } else {
        var mine = d.mine;   // 泵按窗口注入：string=本窗口焦点会话（空串=该窗口当前无会话），undefined=泵无该窗口信息
        if (typeof mine === "string") {
          pickedSid = mine;
          window.__zusageWantSid = mine;
          if (mine) {
            p = sessionFor(d, mine, pid);
            if (!p) p = stubFor(mine);
          } else {
            p = stubFor("");
          }
        } else {
          pc = pickCurrent(d);
          p = pc ? pc.sess : null;
          pickedSid = p ? p.sid : "";
          window.__zusageWantSid = (pc && pc.want) || "";   // 泵读取后让 zusage.py 强制纳入该会话
          if (!p) p = stubFor((pc && pc.want) || "");
        }
      }
      excOn = excActive(p);   // 气泡的显示依据（track 每帧消费）
      lastBand = ctxBandOf(p);   // v92：原生上下文按钮增强的数据源（与状态条上下文格同口径）
      /* 实时 pane 模型优先；没有宿主标记的旧版本才使用最近已完成请求。 */
      readQuotaSelection();
      quotaProvider = quotaSelection ? quotaSelection.providerId : ((p.last && p.last.provider_id) || "");
      quotaModel = quotaSelection ? quotaSelection.modelId : ((p.last && p.last.model) || "");
      quotaFallback = typeof d.provider_fallback === "string" ? d.provider_fallback : "";
      reportQuotaSelections();
      quotaSourceId = "";
      lastQuotaAll = d.quota && typeof d.quota === "object" ? d.quota : null;
      lastResets = lastQuotaAll && lastQuotaAll.resets && typeof lastQuotaAll.resets === "object" ? lastQuotaAll.resets : null;   // v135：重置卡独立字段（旧主进程无则 fail-closed 不渲染）
      if (lastQuotaAll && lastQuotaAll.sources) {
        var qprov = effectiveQuotaProvider();
        var qsid = "";
        if (qprov.indexOf("account:") === 0) {
          if (qprov.indexOf("account:bigmodel-start-plan") === 0 || qprov.indexOf("account:zai-start-plan") === 0) qsid = "zcode-start";
          else qsid = qprov.indexOf("bigmodel") >= 0 ? "bigmodel" : (qprov.indexOf("zai") >= 0 ? "zai" : "");
          /* 未知 account 档不退 active（可能显示他窗自定义源）；team 变体由上方静态提示分支承接 */
        } else if (lastQuotaAll.byProvider && lastQuotaAll.byProvider[qprov]) {
          qsid = lastQuotaAll.byProvider[qprov];   // 自定义 provider：只认主进程显式映射
        }
        quotaSourceId = qsid;
        lastQuota = qsid ? (lastQuotaAll.sources[qsid] || null) : null;
      } else if (lastQuotaAll) {
        /* 旧主进程平铺协议：数据归属未知。内置 account 档按 family 接受（v96 语义即主进程
         * 只查内置套餐）；自定义 provider 无法证明归属 → fail-closed 不显示。 */
        var fp = effectiveQuotaProvider();
        lastQuota = (fp.indexOf("account:") === 0 && fp.indexOf("team") < 0) ? lastQuotaAll : null;
      } else lastQuota = null;
      /* v12 多服务器：remote_today/remote_errors 按目标键分组，取本会话所属主机的分片；
       * 旧格式（单目标，顶层对象即 today）兜底兼容。 */
      var myTarget = p.remote_target || "";
      var remoteToday = null;
      if (p.remote && d.remote_today && typeof d.remote_today === "object") {
        remoteToday = typeof d.remote_today.requests === "number" ? d.remote_today
          : (myTarget && (d.remote_today[myTarget] || remoteTodayCache[myTarget])) || null;
      }
      var view = {
        session: p, last_turn: p.last_turn || {}, last: p.last || {},
        /* v9：远端会话的「今日合计」用远端机数据，本地 today 只在显示本地会话时使用 */
        today: p.remote ? (remoteToday || {}) : d.today,
        native_ctx: nativeCtxVal,
        context_window: p.context_window, context_auto: p.context_auto,
        code: p.code, ctx_exc: p.ctx_exc, tools: p.tools,
        remote: !!p.remote, remote_host: p.remote_host || "", remote_error: p.remote_error || (d.remote_errors && myTarget && d.remote_errors[myTarget]) || (!d.remote_errors && d.remote_error) || "",
        /* v62（issue #14 / #10）：该会话不在本地库且没命中远端 → 条面给一次配置指引，
         * 把"各项全 0 = 插件坏了"的误判转成可执行的下一步；远端命中的会话由 ☁ 徽标那套说明。 */
        not_local: (d.not_local || []).indexOf(p.sid) >= 0 && !p.remote,
        remote_enabled: !!d.remote_enabled,
        remote_stale: !!p.remote_stale,
        remote_empty: !!(p.remote && !p.requests && !p.remote_missing),
        sub: p.sub || {requests: 0, total: 0, input: 0, output: 0, cache_read: 0, active: false, list: []},
      };
      lastSub = view.sub;   // 子代理明细面板的数据源（开关面板/数据推送刷新用）
      lastView = view;   // v146：精简模式速率 chip 的 tooltip 摘要数据源
      refreshWants();
      if (state.theme === "compact" && main.children.length) {
        /* v146 精简模式：不重建条面（条已 display:none），但数据解析（lastBand/quota 选择/
         * reset 字段）照跑——它们是原生按钮增强与额度/重置卡 chip 的数据源；速率 chip 在
         * 此同步（DB 值随推送刷新），子代理明细面板开着时照常跟随。
         * v156：条面空壳（热更占位/清子树后未填过）时不短路，先补一次完整渲染——条隐藏时
         * 渲染不可见，但切回默认时才不会露出空壳细线。 */
        subPopFollowPush(view);
        enhanceCtxButton();
        enhanceQuotaChip();
        enhanceModelPuller();
        enhanceGitChip();
        syncTpsChip();   /* v177：恢复 v146 短路内调用——2976478 挪到公共尾部后短路 return 到不了，
                          * 泵推送的最坏 600ms 延迟落在速率 chip 上且与 git chip 不对称 */
        renderWorkflowCards();   // v332：工作流 run 卡 chip 数据点 reapply（compact 只藏条面，会话流 chip 照常）
        renderRunningSubagentItems();   // v333：状态面板 Agents 行速率 chip 数据点 reapply
        return;
      }
      var h = html(view);
      /* 内容没变就不重建 DOM：泵每 1.5s 推送一次，无条件 innerHTML 会重建条面+重启呼吸灯
       * 动画+触发 tooltip 重画 = 悬停时周期性闪烁（v33 修复）。变化时才重建。 */
      var focusedIndex = -1;
      if (document.activeElement && main.contains(document.activeElement)) focusedIndex = Array.prototype.indexOf.call(main.querySelectorAll(".it"), document.activeElement);
      var restoreFocusTip = focusedIndex >= 0 && tipFor === document.activeElement;
      var previousTip = tipFor;
      var didRebuild = h.s !== lastHtml;
      if (didRebuild) {
        lastHtml = h.s;
        main.innerHTML = h.s;
      }
      var els = main.querySelectorAll(".it");
      for (var i = 0; i < els.length; i++) els[i].__tip = h.tips[i] || null;
      for (var iz = 0; iz < els.length; iz++) els[iz].__zuTipStale = false;   // 整条渲染已按当前 view 重建 __tip，懒构建的失鲜标记作废（独立语句：测试 harness 按上一行源码锚点打补丁）
      if (didRebuild && focusedIndex >= 0) {
        var nextFocus = els[focusedIndex];
        if (nextFocus && nextFocus.focus) {
          restoringFocus = !restoreFocusTip;
          if (restoreFocusTip) tipFor = null;
          try { nextFocus.focus(); } finally { restoringFocus = false; }
        }
        if (!restoreFocusTip && previousTip) tipFor = previousTip;
      }
      liveEl = main.querySelector(".zu-live");   // v71：条面重建后实时段节点重挂（原地更新用）
      if (didRebuild && typeof rotatorMasterTick === "function") rotatorMasterTick();
      /* 数据刷新时正在悬停：接管同位置的新元素继续显示。只调位置不重画内容——
       * 数字每 1.5s 都在变，重画就是闪烁；旧文本保持到鼠标下次移动为止。 */
      if (tipFor) {
        var nu = null;
        if (tipFor === main) nu = main;
        else if (tipFor.__n === els.length) nu = els[tipFor.__idx];
        if (nu && nu.__tip) {
          tipFor = nu;
          if (nu !== main) { nu.__idx = Array.prototype.indexOf.call(els, nu); nu.__n = els.length; }
          if (nu.setAttribute) nu.setAttribute("aria-describedby", tip.id);
          /* v232：速度卡在悬停中随快照跟手（新段完成即重画柱状图；悬停段下标编在串里，
           * 重建不丢高亮）。焦点/选择在 tip 内时跳过防打断——drawTip 自带签名幂等与
           * 选区守卫，内容没变不会真重建。 */
          var focusInTip = tip.contains(document.activeElement);
          /* v308 审查还原：本行曾随模型行 data-tip 批次引入「悬停中冻结快照重绘」
           * （hovFreeze），与已合并的 v224「悬停中 tooltip 随快照跟手刷新」契约冲突
           * （pill-theme 4 例红）；其动机（原生 title 需 ~1s 稳定悬停，生成期重建打断）
           * 已由 02 分片同批的纯 CSS data-tip 气泡消解——重建后 :hover 即时跟随新元素，
           * 无驻留要求，冻结不再有必要，撤销以恢复悬停实时刷新。 */
          var speedFollow = !!(nu.__tip.indexOf && nu.__tip.indexOf("zu-stat-tip--speed") > 0) && !focusInTip;
          /* v242:pill 主题同样受「焦点在 tip 内跳过重绘」守卫——此前无条件 drawTip,
           * 键盘聚焦柱体时一次快照推送就把焦点打回 body(v224 修的是悬停链,此处补齐焦点链) */
          if (!focusInTip && (state.theme === "pill" || document.activeElement === nu || speedFollow)) drawTip(nu, true);
          else positionTip(nu, true);
        } else if (lastPt.x >= 0 && (function () {
          /* v265：接管失败（条目结构随 phase 切换变化）但指针仍悬停在 tooltip 覆盖
           * 区内——保留旧内容原地显示，指针一动即由 mousemove 重新判定该显示什么；
           * 此前直接收掉，生成中 phase 切换（思考↔工具↔正文每次整条重建条面）会让
           * 悬停中的 tooltip 闪断、点击 Tab 落在消息区。 */
          var tr = tip.getBoundingClientRect();
          return lastPt.x >= tr.left && lastPt.x <= tr.right && lastPt.y >= tr.top && lastPt.y <= tr.bottom;
        })()) { positionTip(tipFor, true); }
        else hideTip(false, "render-orphan");
        /* 接管失败（条目结构变化）也受总闸保护：鼠标仍在条上时保持旧 tooltip，
         * 下一次 mousemove 会重新判定该显示哪一项 */
      }
      subPopFollowPush(view);   // v217：统一浮层开着时随推送刷新（会话切换即关，入口重建即重绑）
      enhanceCtxButton();   // v92：数据点 reapply（React 数据更新重写 dasharray 后兜回）
      enhanceQuotaChip();   // v96：额度 chip 数据点 reapply
      enhanceModelPuller();   // v132：宿主设置页「拉取模型」按钮 reapply
      enhanceGitChip();     // v96：同点对账 Git chip（开关/会话切换/scope 变化在此收敛）
      syncTpsChip();        // v155：速率 chip 数据点 reapply（compact 短路与空壳直通两路都经此）
      renderWorkflowCards();   // v332：工作流 run 卡 chip 数据点 reapply（DOM 对账由 heavy 兜）
      renderRunningSubagentItems();   // v333：状态面板 Agents 行速率 chip 数据点 reapply（DOM 对账由 heavy 兜）
    }


    /* ---------- 自绘 tooltip：向上弹出（原生 title 方向不可控） ---------- */
    var tipFor = null, lastMoveAt = 0, tipSig = "", restoringFocus = false;
    var lastPt = { x: -1, y: -1 };   // v265：节流前的最近指针位置（接管失败时判指针是否仍在 tip 覆盖区内）
    var lastTipDownAt = 0;   // v271：最近一次 tip 内按压时刻——按压后 1.2s 硬保活窗

    var mouseInBar = false;   // 鼠标是否悬停在条面/tooltip/面板上（最近一次 mousemove 判定）
    var tipGraceTimer = 0;    // 越顶宽限定时器（v46）
    var tipStats = { mv: 0, shows: 0, hides: 0, last: "", lastHide: "", corridor: 0, grace: 0, hideSeq: [] };   // v275：hideSeq 最近 8 次收起原因（诊断偶发关闭）   // 诊断：随 mount diag 回写
    /* v249 点击激活（zusage3.tipClick，缺省关=即时悬停原语义）：开关开启后悬停不再打开
     * 统计卡/子代理 preview，打开一律走 bar.click；focusTipAt 记录 focusin 刚打开 tooltip
     * 的时刻——点击 .it 会先 focusin 再 click，无此标记首击会被「再点关闭」分支立即抵消。
     * v247 的 1000ms 停留定时器链已整体移除（用户裁定：开关关闭不做停留延迟）。 */
    var focusTipAt = 0;
    /* 隐藏总闸（v33.3）：鼠标还在条面上时，任何路径（数据刷新接管失败/输入框重建/
     * 瞬时不可见判定）都不得隐藏 tooltip——只有鼠标真正离开条面（left-bar，force）
     * 或条面整体隐藏（force）才允许。 */
    function hideTip(force, cause) {
      /* v297.3（开发者常驻开关总闸）：开启后除 Escape、「打开 ⚙ 面板」与点同格
       * 主动关闭（re-click）外，一切自动收起（left-bar/grace/win-leave/
       * focus-leave/render-orphan……）都在此统一拦截——比逐个调用点守卫可靠
       * （第一版漏了 win-leave/focus-leave 两条路径，用户实测「移出仍会关」）。
       * typeof 守卫兼容切片沙箱。 */
      if (state.devKeepTip && cause !== "escape" && cause !== "gear-open" && cause !== "re-click") {
        tipStats.lastHide = "dev-keep:" + (cause || "?");
        return;
      }
      /* v271/v329：tip 内按压后 1.2s 硬保活——点击/按压引发的焦点跌落、宿主重渲染、
       * 命中区边缘误判（left-bar）等任何收起都不得关掉用户正在交互的
       * tooltip（用户实报「点击 tooltips 中的任何位置都会导致关闭」）；win-leave
       * （窗口真失焦）与 Escape、齿轮、同格再次点击、outside（v339 issue #297：点
       * 空白是显式关闭意图，1.2s 内同样放行）与宿主格已消失（bar-hidden/compact-theme/sub-pop）例外。typeof 守卫兼容切片沙箱。 */
      if (cause !== "win-leave" && cause !== "escape" && cause !== "outside" &&
          (cause || "").indexOf("win-leave") !== 0 &&
          cause !== "gear-open" && cause !== "re-click" &&
          cause !== "bar-hidden" && cause !== "compact-theme" && cause !== "sub-pop" &&
          typeof lastTipDownAt !== "undefined" && lastTipDownAt &&
          Date.now() - lastTipDownAt < 1200) {
        tipStats.lastHide = "blocked:" + (cause || "?");
        return;
      }
      if (!force && mouseInBar) { tipStats.lastHide = "blocked:" + (cause || "?"); return; }
      spdHoverPortalHide();   /* v281：Portal 随 tooltip 收起，不留孤儿浮层 */
      spdLegendTipHide();     /* v282：档位说明浮层同链收起 */
      if (tipGraceTimer) { clearTimeout(tipGraceTimer); tipGraceTimer = 0; }
      if (tip.style.display !== "none") tip.style.display = "none";
      if (tipFor && tipFor.removeAttribute) tipFor.removeAttribute("aria-describedby");
      tipFor = null;
      tipSig = "";
      hideFxTip();   // 主 tooltip 收起时费用说明小气泡必无依附，同步收
      tipStats.hides++;
      tipStats.lastHide = cause || "?";
      tipStats.hideSeq.push(cause || "?");
      if (tipStats.hideSeq.length > 8) tipStats.hideSeq.shift();   // v275：诊断偶发关闭
    }
    function positionTip(el, keepTop) {
      var tr = tip.getBoundingClientRect(), ar = el.getBoundingClientRect();
      var left = ar.left + ar.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, Math.max(8, innerWidth - tr.width - 8)));
      /* keepTop=数据刷新等重定位时保持顶边——悬停中只调位置不重建，顶边不动鼠标就
       * 不会因盒形变化被甩出去（外面是 iframe 静默区，甩出去就回不来了）。
       * 只有首次弹出才按条目重新锚定（悬空 8px）。 */
      var top = (keepTop && tip.style.top) ? parseFloat(tip.style.top) : 0;
      if (!isFinite(top) || top < 8) top = Math.max(8, ar.top - tr.height - 8);
      /* v214：展开/数据变化后高度增长时钳底边（keepTop 只保顶边会越出窗口） */
      if (top + tr.height > innerHeight - 8) top = Math.max(8, innerHeight - tr.height - 8);
      /* v285：V2 速度卡左缘对齐锚元素（.it 速度格）左缘——用户规格「基于 .it 的左侧
       * 对齐出现」，替换 v284 的 dock 对齐（宿主类名依赖过重且实测未生效）。
       * __zuAlignLeft 由 drawTip 渲染 V2 内容时置位，非 V2 内容走原居中锚定。 */
      if (tip.__zuAlignLeft) {
        /* v304.1：窄窗口下左对齐会让右缘间隙数倍于左缘（760 卡 in ~764 窗：左 8/
         * 右 ~31，用户实报「最右 padding 与最左不一致」）——窗口富余 <100px 时改
         * 水平居中（两侧等距），宽窗口仍按 v285 贴锚元素左缘。 */
        var slackW = innerWidth - tr.width;
        left = slackW < 100 ? Math.max(4, slackW / 2)
          : Math.max(8, Math.min(ar.left, Math.max(8, innerWidth - tr.width - 8)));
      }
      tip.style.left = Math.round(left) + "px";
      tip.style.top = Math.round(top) + "px";
    }
    /* 实时速度 chip tooltip 的懒构建补建（updateLive 未悬停时不再每拍构建，见其注释）：
     * drawTip 读取 __tip 之前调用，保证打开/聚焦瞬间内容与此刻的 view 一致。 */
    function liveTipRefresh(el) {
      var v = el.__zuTipView;
      el.__zuTipStale = false;
      if (!v) return;
      try { var s = buildLiveTip(v); if (s) el.__tip = s; } catch (e) {
        if (typeof FATAL !== "undefined" && FATAL) FATAL.liveTipRefreshErr = String((e && e.stack) || e);   // 失败保留旧串，留痕供 diag 排查
      }
    }
    function drawTip(el, keepTop) {
      if (el && el.__zuTipStale) liveTipRefresh(el);
      var t = el && el.__tip;
      if (!t) { tip.style.display = "none"; tipFor = null; return; }
      /* 幂等：内容没变就只调位置，不重建 innerHTML（重建=悬停中每 1.5s 闪烁） */
      if (t === tipSig && tip.style.display === "block") {
        positionTip(el, true);
        return;
      }
      var selection = null;
      try { selection = window.getSelection && window.getSelection(); } catch (e) { }
      if (keepTop && selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode &&
          tip.contains(selection.anchorNode) && tip.contains(selection.focusNode)) { positionTip(el, true); return; }
      var oldBody = tip.querySelector ? tip.querySelector(".tbody") : null, oldScroll = keepTop && oldBody ? oldBody.scrollTop : 0;
      /* v232：速度图表横滚位置跨重建保留；v280 扩展——重开路径（keepTop=false，用户
       * 实报「全部×全部拉到末尾、关闭再开回到开头」）同样捕获，并带选择键守卫
       * （.zu-sv-root 的 data-sv-key 同键才回填，切换范围/时间后归零；V1 旧图无键
       * 视为空串键，同内容回填行为与 v232 一致）。 */
      var oldChartL = null, oldChartKey = "";
      if (oldBody) {
        var oc = oldBody.querySelector(".zu-sc-wrap");
        if (oc) {
          var or0 = oldBody.querySelector(".zu-sv-root");
          oldChartKey = or0 ? (or0.getAttribute("data-sv-key") || "") : "";
          oldChartL = oc.scrollLeft;   /* v291 三态：0 也是有效记忆（滚到最左），null=本图无既有位置 */
        }
      }
      tipSig = t;
      hideFxTip();   // innerHTML 重建会换掉 ? 图标节点，旧气泡悬挂无依附——先收
      tip.innerHTML = '<div class="tbody"></div>';
      if (t.charCodeAt(0) === 1) tip.firstChild.innerHTML = t.slice(1);   // \x01 前缀 = 结构化 HTML（v67.1）
      else tip.firstChild.textContent = t;
      tip.firstChild.scrollTop = oldScroll;
      /* v285：V2 卡左对齐标记（positionTip 消费：left=锚元素左缘）；
       * v299.2（用户规格）：本轮 500×350 卡同款居左（与生成速度 tooltip 对齐语义一致） */
      tip.__zuAlignLeft = !!(tip.querySelector(".zu-sv-root") || tip.querySelector(".zu-stat-tip--turn"));
      /* v297：月历网格实测尺寸回写——builder 动态字号的数据源（量测便宜、单元素；
       * 字号变化不改变格尺寸，无测量/布局循环） */
      var nc = tip.querySelector(".zu-sc-wrap");
      if (nc && oldChartL !== null) {
        var nr0 = tip.querySelector(".zu-sv-root");
        if (nr0 ? (nr0.getAttribute("data-sv-key") || "") === oldChartKey : !oldChartKey) {
          nc.scrollLeft = oldChartL;
        } else if (nc.hasAttribute && nc.hasAttribute("data-sv-end")) {
          /* v291：键变（切 Tab 进入全部历史）= 本图无有效记忆，同样滚到最新区 */
          nc.scrollLeft = nc.scrollWidth;
        }
      } else if (nc && nc.hasAttribute && nc.hasAttribute("data-sv-end")) {
        /* v291 历史热力图首开（无记忆位置）：最新日期在最右，初始定位到最右区域；
         * 用户滚过后 oldChartL 非 null 走上方同键回填（含 0=最左），不再跳回（§12.2） */
        nc.scrollLeft = nc.scrollWidth;
      }
      tip.style.display = "block";
      positionTip(el, keepTop);
      /* v297：月历网格实测尺寸回写（动态字号数据源）。v298 起挂 display:block 之后——
       * 隐藏态量测全 0 会把下一帧字号压到 6px 下限（首开闪小字，下轮刷新才自愈）。 */
      var mgEl = tip.querySelector(".zu-hm-grid--mon");
      if (mgEl) {
        var mgr = mgEl.getBoundingClientRect();
        window.__zusageSpdMonRect = { w: mgr.width, h: mgr.height };
      }
      /* v297.2：分段高度诊断（定位宿主「刻度超出图表卡」——tip→tbody→root→body→chart
       * →plotrow→gutcol/gutter/wrap/plot 全层 rect + 关键 computed style）。
       * 必须挂 display:block 之后：隐藏态 getBoundingClientRect 全 0（v298 首版挂在
       * innerHTML 重建处实测六层全 0 废片）。 */
      try {
        var segR = tip.querySelector(".zu-sv-root"), segWrap = tip.querySelector(".zu-sc-wrap"),
          segHead = tip.querySelector(".zu-sv-head"), segPlot = tip.querySelector(".zu-sv-plot"),
          segBody = tip.querySelector(".zu-speed-body"), segChart = tip.querySelector(".zu-sv-chart"),
          segRow = tip.querySelector(".zu-sv-plotrow"), segGutcol = tip.querySelector(".zu-sv-gutcol"),
          segGutter = tip.querySelector(".zu-sc-gutter");
        if (segR) {
          var H8 = function (el) { return el ? Math.round(el.getBoundingClientRect().height) : null; };
          var cs8 = getComputedStyle(segR), csT = getComputedStyle(tip);
          var csCh = segChart ? getComputedStyle(segChart) : null,
            csWp = segWrap ? getComputedStyle(segWrap) : null;
          FATAL.segH = { t: Date.now(), tipH: H8(tip), tipW: Math.round(tip.getBoundingClientRect().width),
            tbodyH: H8(tip.firstChild), rootH: H8(segR),
            bodyH: H8(segBody), chartH: H8(segChart), rowH: H8(segRow),
            gutcolH: H8(segGutcol), gutterH: H8(segGutter),
            headH: H8(segHead), wrapH: H8(segWrap), plotH: H8(segPlot),
            chartPad: csCh ? csCh.padding : null, chartDisplay: csCh ? csCh.display : null,
            chartAlignSelf: csCh ? csCh.alignSelf : null, wrapAlignSelf: csWp ? csWp.alignSelf : null,
            rootPad: cs8.padding, rootBox: cs8.boxSizing,
            tipPad: csT.padding, tipBox: csT.boxSizing };
        }
      } catch (_) { }
    }
    function showTipFor(el) {
      if (tipFor && tipFor !== el && tipFor.removeAttribute) tipFor.removeAttribute("aria-describedby");
      tipFor = el;
      if (el.setAttribute) el.setAttribute("aria-describedby", tip.id);
      var its = main.querySelectorAll(".it");
      el.__idx = el === main ? -1 : Array.prototype.indexOf.call(its, el);
      el.__n = its.length;   // render 接管时校验条目数未变，数量变了 __idx 就不可信
      tipStats.shows++;
      tipStats.last = el === main ? "main" : String(el.textContent || "").slice(0, 12);
      drawTip(el, false);
    }
    main.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); hideTip(true, "escape"); }
    });
    main.addEventListener("focusin", function (e) {
      if (inactive() || restoringFocus || panel.classList.contains("open")) return;
      var item = e.target && e.target.closest ? e.target.closest(".it") : null;
      if (!item || !main.contains(item)) return;
      /* v232 顺带修 v217 回归：.zu-sub 走统一浮层后 __tip 恒 null，滚入判定若被
       * __tip 早退拦截，药丸窄条下子代理入口键盘聚焦不再滚入可视区（pill 夹具实测
       * scrollLeft 恒 0）。滚入只依赖条目矩形，提到 __tip 早退之前。 */
      if (state.theme === "pill" && (item.__tip || item.classList.contains("zu-sub"))) {
        var ir = item.getBoundingClientRect(), mr = main.getBoundingClientRect();
        if (ir.left < mr.left) main.scrollLeft -= mr.left - ir.left;
        else if (ir.right > mr.right) main.scrollLeft += ir.right - mr.right;
      }
      if (!item.__tip) return;   // v217：无 tooltip 的入口（.zu-sub）不进通用 tooltip 链
      mouseInBar = true;
      cancelTipGrace();
      if (item !== tipFor) { showTipFor(item); focusTipAt = Date.now(); }
    });
    main.addEventListener("focusout", function (e) {
      var next = e.relatedTarget;
      if (next && main.contains(next) && next.closest && next.closest(".it")) return;
      if (next && tip.contains(next)) return;   // v214：焦点进入浮层卡片（项目卡按钮等）不关闭
      /* v263：tip 内控件（V2 Tab）点击会同步重编整卡 innerHTML，被点按钮 detach 使焦点
       * 跌落 body——鼠标仍悬停在条面/tooltip 上时这不是「焦点离开」：保住 mouseInBar
       * 并降级为非 force（总闸拦截），指针真正移开由 mousemove 判定收起。否则点击 Tab
       * 的瞬间 tooltip 被强制关掉，切换生效了用户也看不见（「Tab 点击无效」的第二根因，
       * 旧版 click-only 同样中招）。纯键盘（mouseInBar 已 false）维持原强制关闭。 */
      /* v271：tip 内按压后 1.2s 内的焦点跌落（点击空白聚焦 body）直接不关 */
      if (typeof lastTipDownAt !== "undefined" && lastTipDownAt &&
          Date.now() - lastTipDownAt < 1200) return;
      if (mouseInBar) { hideTip(false, "focus-leave"); return; }
      mouseInBar = false;
      if (tipFor) hideTip(true, "focus-leave");
    });
    /* v117 悬停命中区扩到整栏：条目间空隙/分隔符按 sep 中线就近归入左右条目，尾部空隙归
     * 末位条目（.zu-main 默认 space-between + sep 对称 margin，sep 中线恰为相邻条目命中区的
     * 精确分界；v226 水平对齐改居左/居右后依据不变——hitItemFor 按 sep 实际 rect 中线归属，
     * 任何对齐下都成立）。⚙ 在 .zu-main 之外不受影响；空条面与 __tip 缺失的兜底目标返回 null，
     * 维持 v33.2 的"保持当前 tooltip"。 */
    function hitItemFor(t, x) {
      var el = t.closest(".it");
      if (el || !t.closest(".zu-main")) return el || null;
      var its = main.querySelectorAll(".it"), seps = main.querySelectorAll(".sep");
      for (var i = 0; i < seps.length; i++) {
        var sr = seps[i].getBoundingClientRect();
        if (x < (sr.left + sr.right) / 2) return its[i] || null;
      }
      var last = its.length ? its[its.length - 1] : null;
      return (last && last.__tip) ? last : null;
    }
    /* 事件挂 document 捕获阶段（v32）：React/应用层可能在冒泡路上 stopPropagation，
     * 挂 main 的 mousemove 收不到（v31 实证：原生 title 有 hover、自绘 tip 无事件）。
     * stale() 守卫：热更新后旧实例监听器必须罢工，否则新旧两个 tip 同时工作。 */
    listenGlobal(document, "mousemove", function (e) {
      if (inactive()) return;
      if (typeof lastPt !== "undefined") { lastPt.x = e.clientX; lastPt.y = e.clientY; }   // v265：节流前记录，供接管失败判定（v267 typeof 守卫兼容 mousemove 切片沙箱）
      var mt = e.target;
      /* v227：预估费用说明小气泡（fxTip，body 级单例）悬停保活。气泡挂在主 tip/subPanel
       * 之外（tip 上方或覆盖其上），指针移入即落进下方「条外」分支被按 left-bar 强制收
       * 主 tip（hideTip 同步收气泡，v202 起悬停说明气泡即被拖杀）；子代理面板路径则被
       * preview-leave 倒计时收走面板。视同仍在 tooltip 上：先于 150ms 节流，停在气泡里
       * 不动也持续保活（同 subPop 进出判定放节流前的理由）。 */
      if (mt && mt.closest && fxTip.style.display === "block" &&
          (mt === fxTip || (fxTip.contains && fxTip.contains(mt)))) {
        mouseInBar = true;
        cancelTipGrace();
        subPopCancelHide();
        return;
      }
      /* v217 统一子代理浮层：进出判定先于 150ms 节流（preview 离开要跟手）；
       * pinned 不受鼠标影响，浮层/入口内移动取消延迟关闭 */
      if (subPopOpen()) {
        if (mt && mt.closest && (mt.closest(".zu-sub-pop") || mt.closest(".zu-sub"))) subPopCancelHide();
        else subPopScheduleHide();
      }
      tipStats.mv++;
      if (Date.now() - lastMoveAt < 150) return;
      lastMoveAt = Date.now();
      var t = e.target;
      if (!t || !t.closest) return;
      if (tip.contains(t)) { mouseInBar = true; cancelTipGrace(); return; }   // 鼠标移入 tooltip：保持
      if (t.closest(".panel")) {
        /* 面板上不保留条面 tooltip（v42）：开设置的路上触发过条目 tooltip 的话，
         * 这分支若不清掉它，鼠标在面板里它就永不消失。 */
        mouseInBar = true;
        if (tipFor && !state.devKeepTip) hideTip(true, "panel-hover");
        return;
      }
      if (!bar.contains(t)) {
        /* 空中走廊（v45）：悬空缝是"条外且 tip 外"的真空带，采样事件落在这里会被误判
         * 成"移开"立即熄灭——鼠标在 tooltip 横向范围、底边下方 ~12px 内时视同仍在条上，
         * 穿行去 tooltip 点 tab 的路上不熄灭。 */
        if (tipFor && inTipCorridor(e.clientX, e.clientY)) {
          tipStats.corridor++;
          mouseInBar = true;
          cancelTipGrace();
          return;
        }
        /* 越顶宽限（v46）：mousemove 有 150ms 节流采样，快速上移时两个采样点之间能跨过
         * 整个 tooltip，采样点落在 tip 上方的死区——此前立即隐藏就把"正要进 tip"错杀成
         * "离开"。改挂 300ms 宽限：下一个采样落回 tip/走廊就取消（tip 仍可点 tab），
         * 确实继续远离才真正收起。横向/向下移出不享受宽限，依旧立即消失。 */
        if (tipFor && inTipColumn(e.clientX, e.clientY)) {
          tipStats.grace++;
          mouseInBar = true;   // 视同在途：总闸拦住 render-orphan 等路径趁机熄灯
          if (!tipGraceTimer) tipGraceTimer = setTimeout(function () {
            tipGraceTimer = 0;
            if (!state.devKeepTip) hideTip(true, "grace-expire");
          }, 300);
          return;
        }
        /* v329：按压硬保活窗（1.2s）内不触发移开收起，保持 mouseInBar */
        if (typeof lastTipDownAt !== "undefined" && lastTipDownAt &&
            Date.now() - lastTipDownAt < 1200) {
          mouseInBar = true;
          return;
        }
        mouseInBar = false;
        if (tipFor && !state.devKeepTip) hideTip(true, "left-bar");   // v43：移开条面立即消失；v297.3 开发者常驻开关时不自动收
        return;
      }
      mouseInBar = true;
      cancelTipGrace();
      if (panel.classList.contains("open")) return;   // 面板开着：条面不弹 tooltip（弹出也会被面板盖住，只露边角）
      /* v249 点击激活：开关开启后悬停不再打开/切换统计卡与子代理 preview，打开一律走
       * bar.click；早退放在保活/收起分支之后——点开的 tooltip 仍靠上方分支保持与收起。
       * 开关关闭（缺省）= v246 即时悬停原语义，下方逻辑与 v246 逐行为一致。 */
      if (state.tipClick) return;
      /* v217：悬停子代理入口 → preview 打开统一浮层（显式关闭后的短暂抑制内不开）。
       * .zu-sub 的 __tip 为空不走通用 tooltip，命中判定在此处单独承接。 */
      if (subPopMode === "closed" && Date.now() >= subPopSuppressAt) {
        var se = t.closest(".zu-sub");
        if (se) { subPopShow(se, false); return; }
      }
      var el = hitItemFor(t, e.clientX);
      if (el) {
        if (el !== tipFor) showTipFor(el);
        else if (state.theme === "pill" && el.__tip !== tipSig) drawTip(el, true);
      } else if (tipFor) {
        /* 条面内非命中区（⚙ 本体与空条面）：保持当前 tooltip 不动（此处刻意无操作，v33.2）。
         * 条目间空隙/分隔符自 v117 起按 sep 中线就近切换（hitItemFor）；慢速移动的防闪烁
         * 不再依赖"空隙不动"，由 150ms 节流 + tipSig 幂等内容更新承担。 */
      }
    }, true);
    /* 鼠标甩出窗口外/窗口失焦：tooltip 立即收起（v43）。
     * v47 根因修正：ZCode 条面上方的聊天区是独立浏览上下文（iframe/webview，findComposer
     * 穿透同源 iframe 即佐证），光标从条面跨入其上时宿主文档会发 documentElement
     * mouseleave、且后续 mousemove 全部进子文档——diag 实证（mv 上万但 corridor/grace
     * 计数全 0、lastHide=win-leave）这就是"一向上移 tooltip 就消失"的根因：v43 把这种
     * 内部 leave 当成了甩出窗口。故 mouseleave 按退出点分流：
     *   · 退出点贴窗口边缘 = 真离开窗口 → 立即收；
     *   · 内部 leave 且退出点在 tip 横向列内（±30px）= 去 tooltip/回条面的穿行 → 400ms
     *     宽限（子上下文区域事件停摆，靠定时器兜底收回；tip/条面/走廊事件会取消它）；
     *   · 内部 leave 列外 = 横向走掉 → 立即收。 */
    function tipBoundaryHide(src) {
      if (inactive()) return;
      /* v277 修正（最终）：按压硬保活窗（1.2s）延伸到边界事件入口——点击 Tab 后
       * 指针在 tooltip 上，点击引发的合成边界事件（win-leave，hideSeq 铁证：
       * 正常点击被打死）不得关闭进行中的交互；1.2s 外的真离开走原立即关闭
       * （headless pill 测试的启动期 blur 不受影响，全绿实证）。
       * v275 的 pointermove 保活仍作为常规移动路径的兜底。 */
      if (typeof lastTipDownAt !== "undefined" && lastTipDownAt &&
          Date.now() - lastTipDownAt < 1200) return;
      mouseInBar = false;
      if (tipFor) hideTip(true, "win-leave:" + (src || "?"));
    }
    listenGlobal(window, "blur", function () { tipBoundaryHide("blur"); }, true);
    function tipLeaveAt(x, y) {
      if (inactive() || !tipFor) return;
      /* v329：按压硬保活窗（1.2s）内不触发任何离开（防止合成 leave / 边缘跳动误关） */
      if (typeof lastTipDownAt !== "undefined" && lastTipDownAt &&
          Date.now() - lastTipDownAt < 1200) return;
      if (x <= 1 || x >= innerWidth - 2 || y <= 1 || y >= innerHeight - 2) {
        tipBoundaryHide("edge");
        return;
      }
      /* 伪边界过滤（v99）：Chrome 在悬停链收缩/重算时会补发 DOM 内部的 mouseleave
       * （Playwright 实测：滑过格内 .v↔.dim 的 flex 空隙时 documentElement 级必发、
       * tooltip 子元素之间连 tip 本体级都发，坐标在视口内、relatedTarget 是文档内存活
       * 元素）——指针并没有离开本文档。此前每次伪 leave 都按 v47 分流挂 400ms 宽限，
       * 鼠标随即停在格间空白/tooltip 上（无后续事件取消）→ tooltip「弹出后立即关闭」
       * （用户实测悬停「2.85万 1轮 1次」格内 万↔1 空隙必现；tooltip 本体停留同款熄灭）。
       * 事件坐标与 relatedTarget 都不可信（真进 iframe 时 relatedTarget=宿主 body、坐标
       * 也可能落在门外），改问活体：取触发时刻最深 :hover 元素——仍是本档具体元素即伪
       * leave，忽略交给 mousemove 流接管；截断到 body（空档区/已进子文档，v47 宽限语义）、
       * iframe/webview 或空链（甩出窗口）一律按真边界走原分流。 */
      try {
        var hs = document.querySelectorAll(":hover");
        var hovered = hs.length ? hs[hs.length - 1] : null;
        if (hovered && hovered !== document.body && hovered !== document.documentElement &&
            hovered.tagName !== "IFRAME" && hovered.tagName !== "WEBVIEW") return;
      } catch (e) { }
      var r = tip.getBoundingClientRect();
      if (x >= r.left - 30 && x <= r.right + 30) {
        tipStats.grace++;
        mouseInBar = true;   // 在途：总闸拦住 render-orphan 等路径趁机熄灯
        cancelTipGrace();
        tipGraceTimer = setTimeout(function () {
          tipGraceTimer = 0;
          hideTip(true, "grace-expire");
        }, 400);
      } else {
        mouseInBar = false;
        if (!state.devKeepTip) hideTip(true, "left-bar");   // v297.3：开发者常驻开关时不自动收
      }
    }
    listenGlobal(document.documentElement, "mouseleave", function (e) {
      tipLeaveAt(e.clientX, e.clientY);
    }, true);
    /* 光标离开 tooltip 本体：上行越顶/下行回条面 → 列内宽限；横向 → 立即收（分流同上） */
    tip.addEventListener("mouseleave", function (e) {
      tipLeaveAt(e.clientX, e.clientY);
    }, true);
    tip.addEventListener("mouseenter", function () {
      if (inactive()) return;
      cancelTipGrace();
    }, true);
    /* 空中走廊判定（v45）：tooltip 矩形横向 ±4px、纵向 tip 顶边到底边下方 12px
     * （覆盖条面顶边到 tooltip 底边的 8px 悬空缝）。只在 tipFor 存在时被调用。 */
    function inTipCorridor(x, y) {
      var r = tip.getBoundingClientRect();
      return x >= r.left - 4 && x <= r.right + 4 && y >= r.top && y <= r.bottom + 12;
    }
    /* 越顶宽限判定（v46）：tip 正上方 ±30px、高 80px 的柱形区——快速上移的采样点
     * 落进这里说明鼠标刚越过 tip 顶边，大概率下一拍就停在 tip 里。 */
    function inTipColumn(x, y) {
      var r = tip.getBoundingClientRect();
      return x >= r.left - 30 && x <= r.right + 30 && y >= r.top - 80 && y < r.top;
    }
    function cancelTipGrace() {
      if (tipGraceTimer) { clearTimeout(tipGraceTimer); tipGraceTimer = 0; }
    }
    /* v339（issue #297）：点击空白立即收起详情卡。此前唯一关闭途径是鼠标移开
     * （mousemove 采样/leave 分流/chip 的 180ms 延时），详情卡挡住下方消息流时必须
     * 绕开卡片移动鼠标，且 v271/v329 按压硬保活窗会把「点过 Tab 后 1.2s 内点空白」
     * 的收起也吞掉。挂 document 捕获（v32 同因：宿主可能在冒泡路 stopPropagation），
     * target 落在自绘浮层本体/条面/设置面板/各弹框之外即外点：主 tip 收 cause
     * "outside"（进 hideTip 硬保活窗白名单；devKeepTip 总闸不白名单——开发者常驻
     * 模式仍只认 Escape/齿轮/再点同格，契约不变），chip tooltip（额度/速率/重置卡/
     * 子代理行内/git/费用说明/档位说明）一并收。柱体信息卡 Portal 是
     * pointer-events:none，target 不会落在其上，无需排除。 */
    function tipOutsideDown(e) {
      if (inactive()) return;
      var t = e && e.target;
      /* 全关早退：整条链最常见的形态是没有任何浮层打开，不做 closest 探测 */
      if (!tipFor && !quotaTipFor && !rateTipFor && !tpsTipFor && !rstTipFor &&
          !subTipFor && !gitTipFor &&
          fxTip.style.display !== "block" && spdLegendTip.style.display !== "block") return;
      if (!t || !t.closest) return;
      /* 各弹框与统一子代理浮层内部不算外点：各自已有 outside/关闭链，点弹框不联动收 */
      if (t.closest(".zu-rot-pk-dlg,.zu-mp-ov,.zu-compact-dlg,.zu-sub-pop")) return;
      if (panel.classList.contains("open") && panel.contains(t)) return;   // 设置面板内部
      /* 悬停浮层本体内部按压是交互不是关闭（切 Tab/选维度/看图表） */
      if (tip.contains(t) || tpsTip.contains(t) || rstTip.contains(t) || subTip.contains(t) ||
          gitTip.contains(t) || quotaTip.contains(t) || rateTip.contains(t) ||
          (fxTip.style.display === "block" && fxTip.contains(t)) ||
          (spdLegendTip.style.display === "block" && spdLegendTip.contains(t))) return;
      if (bar.contains(t)) return;   // 条面内点击（切格/re-click/⚙）由既有链处理
      if (tipFor) hideTip(true, "outside");
      if (quotaTipFor) hideQuotaTip();
      if (rateTipFor) hideRateTip();
      if (tpsTipFor) hideTpsTip();
      if (rstTipFor) hideRstTip();
      if (subTipFor) hideSubTip();
      if (gitTipFor) hideGitTip();
      if (fxTip.style.display === "block") hideFxTip();
      if (spdLegendTip.style.display === "block") spdLegendTipHide();
    }
    listenGlobal(document, "mousedown", tipOutsideDown, true);
    /* v339（issue #297）：全局 Escape 兜底。焦点不在条目/tip/浮层内（如点空白后落在
     * body）时既有元素级 Escape 链收不到；冒泡挂载让 tip 内分层 Esc（档位说明→费用
     * →关卡，stopPropagation）与 chip/浮层专属 Esc 先行，本 handler 只收漏网的，且不
     * preventDefault/stopPropagation——不吞宿主对 Escape 的语义。 */
    function tipGlobalEsc(e) {
      if (inactive() || !e || e.key !== "Escape") return;
      if (tipFor) { hideTip(true, "escape"); return; }
      if (spdLegendTip.style.display === "block") { spdLegendTipHide(); return; }
      if (tpsTipFor) { hideTpsTip(); return; }
      if (rstTipFor) { hideRstTip(); return; }
      if (subTipFor) { hideSubTip(); return; }
      if (quotaTipFor) { hideQuotaTip(); return; }
      if (rateTipFor) { hideRateTip(); return; }
      if (gitTipFor) { hideGitTip(); return; }
      if (fxTip.style.display === "block") hideFxTip();
    }
    listenGlobal(document, "keydown", tipGlobalEsc);

