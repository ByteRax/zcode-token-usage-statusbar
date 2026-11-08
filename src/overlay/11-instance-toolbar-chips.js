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
        : (v.dbTps ? v.dbTps + " t/s" : "");   /* v298（用户拍板）：chip=最后一轮真实速度（去「均」前缀与会话均） */
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

