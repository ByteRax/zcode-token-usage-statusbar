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
      /* 只信本 pane 的实时编码套餐选择；旧宿主无 marker 时不借历史请求或全局回退，
       * apiKey 与 Start Plan 不能证明重置卡的归属。个人选择=个人卡；团队选择（团队套餐）
       * 时家族重置状态就是 targetType=TEAM 列表，只认所选家族的卡。 */
      var provider = quotaSelection && quotaSelection.providerId;
      /* overlay 自包含 bundle：quota-client 的 teamFamilyOf 不可用，团队规范形在此内联 */
      var teamFam = provider === "account:bigmodel-team-coding-plan" ? "bigmodel"
        : provider === "account:zai-team-coding-plan" ? "zai" : null;
      var personal = provider === "account:bigmodel-individual-coding-plan" ||
                     provider === "account:zai-individual-coding-plan";
      if (!personal && !teamFam) return null;
      var now = Date.now(), earliest = 0, total = 0, fams = [], counts = [];
      ["bigmodel", "zai"].forEach(function (name) {
        if (teamFam && name !== teamFam) return;   // 团队模式：另一家族没有 TEAM 卡
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
        el.addEventListener("mouseenter", function () { cancelRstHide(); var elT = this; zuChipHoverArm(elT, function () { showRstTip(elT); }); });   // v440：悬停门槛（路过不弹）
        el.addEventListener("mouseleave", function () { zuChipHoverDisarm(el); scheduleRstHide(); });   // 延迟收起：给指针移入 tooltip 点「如何重置」留窗口
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
        /* 格面用展示视图（展示协调器防抖/节流后的快照，与条面同款）；tooltip 仍读真实视图 sv */
        var dsv = typeof zuSpDispPick === "function" ? zuSpDispPick(sv, Date.now()) : sv;
        if (dsv) {
          liveKindCur = "live";
          livePhaseCur = sv.phase || "";
          return { kind: "live", sv: sv, face: dsv };
        }
      } else if (typeof zuSpDispPick === "function") zuSpDispPick(null, Date.now());   // 无实时视图即清展示缓存
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
      /* v255：精简模式速度 chip 也走整卡（v384 起 V3：模型筛选/五视图/悬停明细）。
       * 筛选/悬停状态挂数据包，tpsTip 浮层委托见模块层；旧快照缺轮表时原样回退旧摘要卡。 */
      var cv2 = (typeof spd3RebuildOr === "function"
        ? spd3RebuildOr(t && t.speedHistory, (t && t.speedDays) ||
            (typeof lastSpeedDays !== "undefined" && lastSpeedDays) || null,
          (t && t.speedSel) ||
            { range: "recent", period: "recent", dim: "time",
              filt: (typeof spd3FilterAuto === "function" ? spd3FilterAuto() : { mode: "auto", keys: null }),
              pop: { open: false, query: "" } },
          (t && typeof t.speedHover === "number") ? t.speedHover : -1, t && t.speedLive,
          { fmtTok: fmt, fmtCnt: countFmt, fmtMoney: state.cost ? fmtMoney : null }, sess)
        : null);
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
      chip.addEventListener("mouseenter", function () { cancelTpsHide(); zuChipHoverArm(chip, function () { showTpsTip(chip); }); });   // v440：悬停门槛（路过不弹）
      chip.addEventListener("mouseleave", function () { zuChipHoverDisarm(chip); scheduleTpsHide(); });   // 延迟收起：给指针移入 tooltip 留窗口（同重置卡桥）
      chip.addEventListener("focus", function () { showTpsTip(chip); });
      chip.addEventListener("blur", hideTpsTip);
      chip.addEventListener("keydown", function (e) { if (e.key === "Escape") hideTpsTip(); });
      /* 右键直开设置（用户规格 2026-11-09）：精简下 chip 是唯一常驻入口，悬停 tooltip
       * 里点「打开设置」要两步；右键镜像 .tps-cfg 路径——先收 tooltip 再开面板，
       * 并压掉宿主原生右键菜单。 */
      chip.addEventListener("contextmenu", function (e) {
        if (e && e.preventDefault) e.preventDefault();
        hideTpsTip();
        if (chip.__zuOpen) chip.__zuOpen();
      });
    }
    /* 精简速率 chip 的布局档位（specs/speed-chip-stable-slot.md）：外宽只随档位变、不随状态文字变；档位只由宿主
     * 工具行的真实空间决定，与本 chip 自身宽度无关——空位 = 前导区可用宽度（宿主 flex:1 的
     * [data-composer-leading-actions]）− 同区其它内容（宿主按钮 + 本插件其它 chip）。宿主放不下时会逐级压缩
     * 它自己的按钮（useComposerToolbarFit），所以本 chip 先让位：放不下就在同一次判定里降到装得下的那一档
     * （空位与自身宽度无关，同拍算到底安全；挂载当拍即到位），宿主已在压缩则再让一档、一次只让一档；升档只在
     * 距上一次降档或见到宿主压缩 ≥2s、且空位 ≥ 上一档宽度 + FOLD_HYS 时发生。因宿主压缩而降档后，宿主若因此展开，空位必然
     * 小于刚让出的那一档，升档条件不成立——两侧不会互相拉锯。同区的 Git/系统状态 chip 按对称公式各自升降
     * （gitMeasureAvail），同一拍双双升档撑破一行时，本 chip 的 2s 静默期保证下一轮只有一边先升、另一边
     * 发现空间不够而停住。挂载当拍即量（chip 插入后、宿主 ResizeObserver 之前），空间不够时 chip 已先降档，
     * 宿主不必压缩。找不到宿主前导区（其它宿主/旧布局）或前导区尚无尺寸（窗口最小化、后台分栏）时不分档、
     * 不改动。zuTsbTierNext 是纯函数（回归在 tests/overlay-speed-slot.test.cjs）；测量与写类名在 zuTsbTierSync，
     * 至多每 250ms 量一次（窗口拖窄时两档让位在半秒内完成，宿主按钮的压缩只闪一下；心跳 10Hz 进来只做时间戳比较）。 */
    var ZU_TSB_TIERS = [12.4, 9.7, 6.6];   // em：宽裕（标签+数值+单位）/ 中等（去单位）/ 紧张（仅数值），与 06 分片样式同源
    var ZU_TSB_TIER_MS = { measure: 250, dwell: 2000 };   // 测量至多 4Hz（条内窄宽状态机是逐帧 60Hz）；降档后 2s 静默期
    var tsbTier = 0, tsbTierAt = 0, tsbTightAt = 0;
    function zuTsbTierNext(cur, tight, room, emPx, hys, mayRise) {
      while (cur < ZU_TSB_TIERS.length - 1 && room < ZU_TSB_TIERS[cur] * emPx) cur++;   // 放不下：同一次判定直接降到装得下的那一档（空位与自身宽度无关，所以算到底是安全的；挂载当拍就到位，宿主不必先压缩）
      if (cur < ZU_TSB_TIERS.length - 1 && tight) return cur + 1;                       // 宿主已在压缩：让一档，一次只让一档（防拉锯证明依赖这一点）
      if (cur > 0 && mayRise && room >= ZU_TSB_TIERS[cur - 1] * emPx + hys) return cur - 1;   // 升档：一次一档，带迟滞与静默期
      return cur;
    }
    function zuTsbTierSync(chip) {
      var lead = chip.closest("[data-composer-leading-actions]"), content = chip.closest("[data-composer-leading-content]");
      var now = Date.now();
      if (!lead || !content || !lead.parentElement) {   // 无宿主前导区：不分档
        if (tsbTier) { tsbTier = 0; chip.classList.remove("zu-speed-mid", "zu-speed-tight"); }
        return;
      }
      if (now - tsbTierAt < ZU_TSB_TIER_MS.measure) return;
      var leadW = lead.getBoundingClientRect().width;
      if (!(leadW > 0)) return;   // 尚无尺寸：不判定（否则空位算成 0 会误降到最窄档）
      tsbTierAt = now;
      var root = lead.parentElement;
      var room = leadW - (content.getBoundingClientRect().width - chip.getBoundingClientRect().width);
      var tight = !!(root.querySelector("[data-composer-compact]") || root.dataset.composerProviderCompact || root.dataset.composerModelIcon);
      if (tight) tsbTightAt = now;
      var next = zuTsbTierNext(tsbTier, tight, room, parseFloat(getComputedStyle(chip).fontSize) || 13, FOLD_HYS,
        now - tsbTightAt >= ZU_TSB_TIER_MS.dwell);
      if (next === tsbTier) return;
      if (next > tsbTier) tsbTightAt = now;   // 刚让过位：静默期内不回升
      tsbTier = next;
      chip.classList.toggle("zu-speed-mid", next === 1);
      chip.classList.toggle("zu-speed-tight", next === 2);
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
        tsbTier = 0; tsbTierAt = 0;   // 新挂或换宿主：档位从头量（本拍末尾即量，见 zuTsbTierSync）
        chip.classList.remove("zu-speed-mid", "zu-speed-tight");
      }
      var misplaced;
      /* 用 nextElementSibling 判位（nextSibling 会被文本节点打乱，造成每拍重插） */
      if (insBefore) misplaced = chip.nextElementSibling !== insBefore;
      else misplaced = (afterNode ? afterNode.nextElementSibling !== chip : host.lastElementChild !== chip);   // 锚位语义同 git 兜回（下一元素已是自己=就位，不得自插）
      if (misplaced) host.insertBefore(chip, insBefore ? insBefore : (afterNode ? afterNode.nextElementSibling : null));
      /* v298（用户拍板）：chip=最后一轮真实速度（去「均」前缀与会话均）。格面走展示模型
       * （标签+数值+单位，specs/speed-chip-stable-slot.md）：实时态的数值与档位色取同一展示快照；
       * 回退态档位色按面上数字（最后一轮）分档——v.band 是会话均的档，只供 tooltip 左卡。 */
      var fv = v.kind === "live" ? (v.face || v.sv) : { kind: "real", db: true, speedValue: v.dbTps > 0 ? v.dbTps : null };
      var txt = v.kind === "live" ? v.sv.text : (v.dbTps ? v.dbTps + " t/s" : "");
      var fbBand = v.dbTps > 0 ? tpsBand(v.dbTps) : null;
      var cls = "zu-live " + (v.kind === "live" ? fv.cls + (fv.word ? " zu-shimmer" : "") : (fbBand ? fbBand.cls : "dim"));
      /* v464：chip 按内容定宽，长计时面（≥1h）保留状态词（固定宽的速度格才不出；autoWidth=true） */
      var face = zuSpeedFaceHtml(fv, true);
      var sig = v.kind + "|" + cls + "|" + face;
      if (chip.__zuSig !== sig) {   // 幂等：内容没变不重建，悬停/焦点态不被打断
        chip.__zuSig = sig;
        /* 标签/数值/单位三 item 与条内速度格同构（间距由 gap 提供，v326 机制延续） */
        chip.innerHTML = '<span class="' + cls + '">' + face + "</span>";
        chip.setAttribute("aria-label", L("生成速度 ", "Generation speed ") + txt);
      }
      var prevT = chip.__zuT;
      chip.__zuT = { v: v, view: lastView, buildTip: tpsChipTipHTML,
        /* v255：轮表与筛选/悬停状态随 chip 包走，10Hz 心跳不重置用户选择；v384 加 speedDays */
        speedHistory: (state.data && state.data.speed_history) || (prevT && prevT.speedHistory) ||
          (typeof lastSpeedHistory !== "undefined" && lastSpeedHistory) || null,
        speedDays: (state.data && state.data.speed_days) || (prevT && prevT.speedDays) ||
          (typeof lastSpeedDays !== "undefined" && lastSpeedDays) || null,
        speedSel: (prevT && prevT.speedSel &&
          prevT.sessId === ((lastView && lastView.session && lastView.session.sid) || "")) ? prevT.speedSel :
          /* v384 m6：会话变化不继承旧 pane 筛选（实例链 07:627 同款重置语义）。
           * 身份取 lastView.session.sid——本函数作用域无 sess 变量（S7 P1 实测
           * ReferenceError），chip 面的会话归属与格面同源。 */
          { range: "recent", period: "recent", dim: "time",
            filt: (typeof spd3FilterAuto === "function" ? spd3FilterAuto() : { mode: "auto", keys: null }),
            pop: { open: false, query: "" } },
        sessId: (lastView && lastView.session && lastView.session.sid) || "",
        speedHover: prevT && typeof prevT.speedHover === "number" ? prevT.speedHover : -1,
        speedLive: v.kind === "live" ? v.sv : null };
      var lite = bar.classList.contains("zu-light");
      syncCtxLite(chip, lite);
      chip.classList.toggle("zu-light", lite);   // 速率档色的浅色组按 .zu-light 祖先匹配（条隐藏后祖先缺失，类挂 chip 自身补链）
      if (tpsTipFor === chip) showTpsTip(chip);   // 悬停中随心跳/推送刷新：签名不变不重建
      zuTsbTierSync(chip);
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
    /* OpenCode Go 不按模型换算（v447 撤回 v385，issue #453）：/console/api/go/status 的 meters
     * 是账号共享额度池本身（额度口径金额，请求按各模型月度额度折算计入同一池），窗口的
     * total、used、percent 一律原样展示。官方各模型「月度额度」只是整月单用该模型时的标价
     * 用量覆盖，不是独立池；按它放大总额会把官方已用比例改坏（issue #453：月窗已用 40.33%
     * 曾被显示成 24.2%）。规格 specs/opencode-model-allowance.md。 */
    /* chip 分段：每个窗口一段（5时/7天/月；2026-11-17 用户规格：5小时→5时、本月→月，
     * 全档统一短标签，tooltip 保留「5小时窗口/本月窗口」全称），各自按已用 % 上档位色；余额类型一段（阶段 3 数据源接入即用） */
    function quotaSegs(q) {
      var w = q && q.windows, out = [];
      if (!w) return out;
      var defs = [["daily", "今日", "1d"], ["fiveHour", "5时", "5h"], ["weekly", "7天", "7d"], ["monthly", "月", "1mo"], ["plan", "套餐", "plan"]];
      for (var i = 0; i < defs.length; i++) {
        var e = w[defs[i][0]];
        /* isFinite 门：NaN/±Infinity 不进分段，绝不落成正常色（v127） */
        if (e && typeof e.percent === "number" && isFinite(e.percent)) out.push({ label: L(defs[i][1], defs[i][2]), key: defs[i][0], pct: e.percent });
      }
      return out;
    }

    /* ---------- v382 套餐额度 chip 工具栏四级响应式（specs/quota-chip-responsive.md）----------
     * 以下纯函数只读数据、不触 DOM，供 VM 单测；模块级 seam 暴露给测试夹具。
     * 显示形态（L0 完整 / L1 紧凑 / L2 摘要 / L3 最小）不是固定屏幕宽度，由真实工具栏
     * 可用宽度选。档位色、quotaRemain 口径、Tooltip 数据一律沿用旧链，不在本层重算。 */
    var QUOTA_SHORT = {
      daily: ["今日", "1d"], fiveHour: ["5时", "5h"], weekly: ["7天", "7d"], monthly: ["月", "1mo"], plan: ["套餐", "plan"]
    };
    function quotaShortLabel(seg, lang) {
      if (!seg) return "";
      var pair = QUOTA_SHORT[seg.key];
      if (!pair) return seg.label;
      return lang === "en" ? pair[1] : pair[0];
    }
    /* 主展示窗口：告警（原始已用≥90=crit/exc）优先，exc>crit；同级按既有顺序稳定取首个；
     * 无告警时取第一个有明确短周期的窗口（daily/fiveHour/weekly），否则取第一个有效窗口。
     * 一律用原始已用 pct，quotaRemain 不影响选择与严重度。 */
    function pickQuotaPrimary(segs) {
      if (!segs || !segs.length) return null;
      var sev = function (pct) { return pct >= 100 ? 3 : pct >= 90 ? 2 : 0; };
      var best = null, bestSev = 0;
      for (var i = 0; i < segs.length; i++) {
        var s = sev(segs[i].pct);
        if (s > bestSev) { bestSev = s; best = segs[i]; }
      }
      if (best) return best;
      for (var j = 0; j < segs.length; j++) {
        if (segs[j].key === "daily" || segs[j].key === "fiveHour" || segs[j].key === "weekly") return segs[j];
      }
      return segs[0];
    }
    /* 候选显示串：L0/L1 全窗口，L2 主窗口+N，L3 图标+主窗口(可退化纯图标)。
     * 每项 {html, aria}；aria 恒用完整 segs（所有窗口真实信息），不因收缩裁剪。 */
    function quotaCandidates(mode, lang, remain, bands, bandOfFn) {
      var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      }); };
      var full = [];
      try { full = (mode && mode.segs) || []; } catch (e) { }
      /* 非窗口形态（余额/Key剩余/info/team/error/quotaSummary）保持既有单段 html/aria 原样，
       * 不进多窗口候选构造（原有语义逐字不动）；外层只决定是否收窄占位。 */
      if (!mode || mode.kind !== "value" || !full.length) {
        var unchanged = { html: (mode && mode.html) || "", aria: (mode && mode.aria) || "" };
        /* 最小档退为额度图标（保留完整 aria + Tooltip 数据），避免窄屏直接隐藏单段形态。 */
        var qico = '<svg class="zu-qico zu-qb-calm" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
          'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>';
        return { L0: unchanged, L1: unchanged, L2: unchanged, L3: unchanged, L3I: { html: qico, aria: unchanged.aria } };
      }
      var primary = pickQuotaPrimary(full);
      var shownPct = function (pct) { return Math.round(remain ? quotaRemainPct(pct) : pct); };
      var segHtml = function (seg, short) {
        var label = short ? quotaShortLabel(seg, lang) : seg.label;
        return '<span class="zu-qseg ' + bandOfFn(bands, seg.pct) + '"><span class="zu-qlabel">' +
          esc(label) + "</span> " + shownPct(seg.pct) + "%</span>";
      };
      var fullSegs = function (short, sep) {
        return full.map(function (s) { return segHtml(s, short); }).join('<span class="zu-qsep">' + sep + "</span>");
      };
      var warn = mode.warn ? mode.warn : "";
      var fullAria = (remain ? L("套餐剩余 ", "Plan remaining ") : L("套餐已用 ", "Plan used ")) +
        full.map(function (s) { return s.label + " " + shownPct(s.pct) + "%"; }).join(L("，", ", "));
      var extra = full.length > 1 ? '<span class="zu-qextra">+' + (full.length - 1) + "</span>" : "";
      var icon = function (cls) {
        return '<svg class="zu-qico ' + (cls || "") + '" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
          'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>';
      };
      var pcls = primary ? bandOfFn(bands, primary.pct) : "zu-qb-calm";
      var pshort = primary ? quotaShortLabel(primary, lang) : "";
      var pval = primary ? shownPct(primary.pct) : 0;
      var warnOnly = mode && mode.kind !== "value" ? mode.html : "";
      var l0 = full.length ? fullSegs(false, "|") + warn : warnOnly;
      var l1 = full.length ? fullSegs(true, "·") + warn : warnOnly;
      var l2 = primary ? segHtml(primary, true) + extra + warn : warnOnly;
      var l3full = primary ? icon(pcls) + '<span class="zu-qseg ' + pcls + '">' + esc(pshort) + " " + pval + "%</span>" + warn : warnOnly;
      var l3icon = icon(pcls) + warn;   // 极窄档也保留 ⚠：错误/过期态比宽度更重要（收口 review）
      return {
        L0: { html: l0, aria: fullAria || (mode && mode.aria) || "" },
        L1: { html: l1, aria: fullAria || (mode && mode.aria) || "" },
        L2: { html: l2, aria: fullAria || (mode && mode.aria) || "" },
        L3: { html: l3full, aria: fullAria || (mode && mode.aria) || "" },
        L3I: { html: l3icon, aria: fullAria || (mode && mode.aria) || "" }
      };
    }
    /* 选级：candidates 顺序从最完整到最简，avail 为额度 chip 可用宽度（<0 视为无法容纳）；
     * measure 为候选自然宽测量函数（返回 px）。展开迟滞只在"当前等级更简、新等级更完整"时
     * 要求 avail >= need + hyst；收缩无迟滞，立即降级。返回选中等级 key。
     * hidden=极限降级（连最简都放不下）；rank.hidden 置为最紧凑侧，使从 hidden 回展也按同一迟滞门控，防临界抖动反复建销节点。 */
    function pickQuotaDisplayLevel(order, avail, measure, current, hyst) {
      var h = hyst || 0;
      var rank = {};
      for (var i = 0; i < order.length; i++) rank[order[i]] = i;
      rank.hidden = order.length;   // hidden 是最紧凑侧（rank 最大）：从 hidden 回展需 +hyst，防临界抖动反复建销节点
      for (var j = 0; j < order.length; j++) {
        var key = order[j], need = measure(key);
        if (avail < need) continue;
        if (current && rank[key] < rank[current] && avail < need + h) continue;
        return key;
      }
      return "hidden";   // 连最简都放不下：极限降级（隐藏 chip）
    }
    /* 以下 DOM 适配常量/变量必须先声明再暴露测试缝（var 只提升声明不提升赋值，
     * 曾因缝对象先赋值引用 QUOTA_ORDER 得到 undefined 埋隐患）。 */
    var QUOTA_ORDER = ["L0", "L1", "L2", "L3", "L3I"];
    var QUOTA_HYST = 20;   // 展开迟滞 16–24px；收缩无迟滞
    var QUOTA_SAFE_GAP = 8;   // 与 leading 内容保持的最小安全间距
    var quotaMeasureOverride = null;   // 测试注入点（VM 无真实布局）；生产恒 null
    var quotaAvailSig = "", quotaAvailVal = 0;   // avail 测量签名缓存：render+heavy 双调用点同几何零强制 layout
    if (typeof window !== "undefined") {
      var quotaSeamInst = {};   // 实例级令牌：缝按实例创建覆盖赋值，dispose 据此只删本实例（最后创建者）的缝
      window.__zusageQuotaFns = {
        quotaShortLabel: quotaShortLabel, pickQuotaPrimary: pickQuotaPrimary,
        quotaCandidates: quotaCandidates, pickQuotaDisplayLevel: pickQuotaDisplayLevel,
        quotaMeasureAvail: quotaMeasureAvail, quotaLeadingRight: quotaLeadingRight,
        QUOTA_BANDS: QUOTA_BANDS, QUOTA_ORDER: QUOTA_ORDER, QUOTA_HYST: QUOTA_HYST,
        __zuInst: quotaSeamInst,
        all: function () { return {
          quotaShortLabel: quotaShortLabel, pickQuotaPrimary: pickQuotaPrimary, quotaCandidates: quotaCandidates,
          pickQuotaDisplayLevel: pickQuotaDisplayLevel, quotaMeasureAvail: quotaMeasureAvail,
          quotaLeadingRight: quotaLeadingRight,
          QUOTA_BANDS: QUOTA_BANDS, QUOTA_ORDER: QUOTA_ORDER, QUOTA_HYST: QUOTA_HYST
        }; },
        setMeasureOverride: function (fn) { quotaMeasureOverride = fn; }
      };
    }
    function quotaMeasureProbe() {
      if (quotaRespProbe && quotaRespProbe.isConnected) return quotaRespProbe;
      var probe = document.createElement("span");
      probe.className = "zu-qmeasure";   // 独立类名（不复用 .zu-quota），避免全局 querySelector/DOM 自清误命中离屏节点
      probe.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;width:max-content";
      probe.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(probe);
      quotaRespProbe = probe;
      return probe;
    }
    function quotaMeasureWidth(html, levelKey) {
      var probe = quotaMeasureProbe();
      /* 档位属性与候选串同源更新：探针按该档盒模型测宽（L1 gap 收紧、+N 缩小字号——
       * CSS 镜像规则见 06 分片 .zu-qmeasure[data-zusage-qlevel]）。 */
      if (levelKey) probe.setAttribute("data-zusage-qlevel", levelKey);
      else probe.removeAttribute("data-zusage-qlevel");
      if (probe.__zuHtml !== html) {   // 候选串没变不重写/不重排（render+heavy 双调用点高频）
        probe.innerHTML = html;
        probe.__zuHtml = html;
        try { probe.__zuW = probe.getBoundingClientRect().width || 0; } catch (e) { probe.__zuW = 0; }
      }
      return probe.__zuW;
    }
    /* leading 内容右缘：优先宿主 [data-composer-leading-content]（shrink-0 内容定宽，不随
     * trailing 增宽移动），回退本插件 Git chip 右缘；找不到返回 null → fail-safe 保持 L0。 */
    function quotaLeadingRight(btn) {
      var node = btn;
      for (var depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        var lead = null;
        try { lead = node.querySelector ? node.querySelector("[data-composer-leading-content]") : null; } catch (e) { }
        if (lead && typeof lead.getBoundingClientRect === "function") {
          var r = lead.getBoundingClientRect();
          if (r && r.width > 0 && isFinite(r.right)) return r.right;
        }
      }
      try {
        var git = gitChipCache && gitChipCache.isConnected ? gitChipCache : null;
        if (git) {
          var g = git.getBoundingClientRect();
          if (g && g.width > 0 && isFinite(g.right)) return g.right;
        }
      } catch (e) { }
      return null;
    }
    /* 返回额度 chip 的真实可用宽度；null=无法可靠测量（VM stub / 宿主结构未标定）→ 保持 L0。
     * 不变式（真实 CDP 取证 2026-11-17）：trailing 组右对齐（ml-auto），chip 增宽 Δ 时 chip
     * 左缘左移 Δ、压缩与 leading 内容的空隙，与 leading 右缘的间距 G 满足 chipW+G ≡ 常量——
     * 故 avail = refW + (ref.left − leadingRight) − SAFETY 与 chip 当前宽度无关（自指相消），
     * 收缩/隐藏都不会把它坍缩成 0（hidden 黑洞）。chip 已摘除时 ref=btn、refW=0（此时
     * btn.left − leadingRight 就是纯空隙，加 btnW 反而虚高）。
     * 反面教材：不能用 chip 所在 trailing 行自身 clientWidth 作分母——该行右对齐贴内容，
     * 行宽≈内容宽，相减恒得 ≈0（v382 首版缺陷，chip 摘除后永久隐藏）。 */
    function quotaMeasureAvail(btn, chip, leadingRight) {
      var wrap = btn && btn.parentElement;
      var row = wrap && wrap.parentElement;
      if (!row || typeof row.getBoundingClientRect !== "function") return null;
      /* clientWidth 缺席（VM stub / 脱离布局的临时节点）时无法可靠测量，fail-safe 保持完整档，绝不猜测收窄。 */
      if (typeof row.clientWidth !== "number") return null;
      /* 只在本项目实测过的宿主 trailing 行（overflow:hidden + min-w-0）上启用收缩；
       * 其它宿主版本/测试夹具的行结构未标定，fail-safe 保持 L0，绝不在未知容器上误判隐藏 chip。 */
      if (!row.classList || !row.classList.contains("overflow-hidden") || !row.classList.contains("min-w-0")) return null;
      var L = (typeof leadingRight === "number") ? leadingRight : quotaLeadingRight(btn);
      if (L == null) return null;
      var hasChip = !!(chip && chip.isConnected);
      var ref = hasChip ? chip : btn;
      var rr = null;
      try { rr = ref.getBoundingClientRect(); } catch (e) { }
      if (!rr || !isFinite(rr.left)) return null;
      /* 几何签名：ref 左缘/宽 + leading 右缘变化才重算，避免 render+heavy 高频路径反复读 rect。 */
      var sig = Math.round(rr.left) + "|" + Math.round(rr.width) + "|" + Math.round(L) + "|" + (hasChip ? 1 : 0);
      if (sig === quotaAvailSig) return quotaAvailVal;
      var avail = (hasChip ? rr.width : 0) + (rr.left - L) - QUOTA_SAFE_GAP;
      quotaAvailSig = sig;
      quotaAvailVal = isFinite(avail) ? Math.max(0, Math.round(avail)) : 0;
      return quotaAvailVal;
    }
    function quotaApplyLevel(chip, mode, btn) {
      if (quotaMeasureOverride) {
        var r = quotaMeasureOverride(mode, state.lang, state.quotaRemain === 1, QUOTA_BANDS, bandOf, quotaRespLevel);
        chip.__zuQLevel = r.level; quotaRespLevel = r.level;
        chip.setAttribute("data-zusage-qlevel", r.level);
        return r.candidates[r.level];
      }
      var cands = quotaCandidates(mode, state.lang, state.quotaRemain === 1, QUOTA_BANDS, bandOf);
      /* 非窗口形态（余额/info/team/error/quota）保持单行原样，只走 L0/L3I 两态，不做多窗口压缩。 */
      var order = mode.kind === "value" ? QUOTA_ORDER : ["L0", "L3I"];
      var avail = quotaMeasureAvail(btn, chip);
      var level = "L0";
      if (avail !== null) {
        var measure = function (key) { return quotaMeasureWidth(cands[key].html, key); };
        /* current 取实例级持久等级：极限降级摘除节点后重建也不丢迟滞态，防 hidden↔L0 震荡。 */
        var chosen = pickQuotaDisplayLevel(order, avail, measure, quotaRespLevel, QUOTA_HYST);
        /* pick 返回 "hidden"=连纯图标都放不下：极限降级隐藏 chip（不遮挡原生控件），
         * 恢复宽度后 pick 按 hidden 的 rank 迟滞回展；避免临界抖动反复建销节点。 */
        if (chosen === "hidden") { chip.__zuQLevel = "hidden"; quotaRespLevel = "hidden"; chip.setAttribute("data-zusage-qlevel", "hidden"); return null; }
        level = chosen;
      }
      chip.__zuQLevel = level;
      quotaRespLevel = level;
      chip.setAttribute("data-zusage-qlevel", level);
      return cands[level];
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
        return { kind: "value", stale: !!q.stale, busy: !!q.busy, segs: segs, rem: rem, warn: warn,
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
          chip.addEventListener("mouseenter", function () { var qT = this; zuChipHoverArm(qT, function () { onQuotaEnter.call(qT); }); });   // v440：悬停门槛（路过不弹；focus 走 onQuotaEnter 原样即时）
          chip.addEventListener("mouseleave", function () { zuChipHoverDisarm(chip); hideQuotaTip(); });
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
      var shown = quotaApplyLevel(chip, mode, btn);   // v382：按真实工具栏可用宽度选显示等级
      if (!shown) {   // 极限降级：连图标都放不下→摘除 chip（保留 __zuQ 数据，恢复宽度即重现），不遮挡原生控件
        if (quotaTipFor === chip) hideQuotaTip();
        try { chip.remove(); } catch (e) { }
        quotaChipCache = null;
        ariaLiveState.__zuQuotaLive = "";
        ariaLiveState.textContent = ariaLiveState.__zuGitLive || "";
        return;
      }
      var sig = mode.kind + "|" + (mode.stale ? 1 : 0) + "|" + chip.__zuQLevel + "|" + shown.html;
      var qbusy = !!(lastQuota && lastQuota.busy);
      if (chip.__zuSig !== sig) {   // 幂等：内容/等级没变不重建，悬停/焦点态不被打断
        chip.__zuSig = sig;
        chip.className = "zu-quota" + (mode.stale ? " zu-qstale" : "") + (qbusy ? " zu-qbusy" : "");
        chip.setAttribute("aria-label", shown.aria);
        chip.innerHTML = shown.html;
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

    /* ---------- v344 增强提示词按钮：模型 chip 左侧 ----------
     * 锚点：模型选择触发按钮（chat-model-select-trigger；空配置「管理模型」分支同名 testid
     * 一并覆盖）优先，缺位回退用量圆环（与额度 chip 同源锚缓存）；两者都缺不挂。
     * 点击读当前 composer 草稿（__zcodeLexicalInputE2E——Lexical 直写 DOM 不进 EditorState，
     * 该 E2E 桥是唯一官方写通道），经 pluginRequest("prompt-enhance") 由主进程按会话模型
     * 凭据一次性改写后回填；回填前重读草稿比对，用户已编辑则不覆盖。相位 idle→enhancing
     * 警示态 4s 自愈（v350.1 撤销相位已删除）。开关 enhance_enabled（推送面 enhanceEnabled）关
     * 闭或实例停用一律 restore；双 reapply（render 数据点 + heavy 对账点）兜回位置与相位，
     * __zuPhase 签名幂等，busy 旋转走 aria-busy CSS 不打断。 */
    var enhanceBtnCache = null;
    var enhancePhase = "idle";   // idle | enhancing
    var enhanceTimer = 0;        // 写入确认延时器（v350.1 起非撤销窗）
    var enhanceWaitTimer = 0;    // 渲染端等待兜底（主进程 60s 超时 + 轮询量级余量）
    var enhanceWarnText = "";    // 非空 = 警示态（4s 自愈）
    var enhanceWarnTimer = 0;
    var enhanceSettled = true;   // v344.1：true=本次请求已被消费/取消，迟到回包一律丢弃
    var enhanceInFlightId = "";  // v344.1：在途请求的 requestId（取消动作的定位键）
    var enhanceStartedAt = 0;    // 历史记录：本次增强发起时间（durationMs 用）
    var enhanceOriginal = "";    // 增强前草稿（历史记录 originalText 用）
    var enhanceSid = "";         // v344.3：发起时的会话身份（instSid/pickedSid）——回填前校验，防止结果写进切走后的新会话
    var enhanceCurSid = function () { return instSid || pickedSid || ""; };
    var enhanceScopeKey = "", enhanceOriginalState = "";
    function enhanceStateOf(api) {
      try { return api && typeof api.getEditorState === "function" ? JSON.stringify(api.getEditorState()) : ""; } catch (e) { return ""; }
    }
    function enhanceCurrentScope() {
      var sid = enhanceCurSid(), scope = readPaneScope(wantedEl, sid, pid, true);   // v354：增强链显式放行 draft（新会话未发首条消息）；其余消费面不传该参维持拒绝
      return scope ? JSON.stringify([scope.sid, scope.identity, scope.workspacePath, scope.remoteSessionId]) : "";
    }
    var ENHANCE_ANCHOR_SEL = '[data-testid="chat-model-select-trigger"]';
    var ENHANCE_INPUT_SEL = '[data-testid="v4-composer-input"]';
    var ENHANCE_WAIT_MS = 75000, ENHANCE_WARN_MS = 4000;
    var ENH_SVG_STAR = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="flex:0 0 auto"><path transform="matrix(1 0 0 1 0.524459 0.757238)" d="M6.1838 2.2198C6.6022 1.3093 7.8641 1.2266 8.1057 2.0939L8.84 4.7335C8.992 5.2783 9.3896 5.6893 9.9289 5.8595L12.5431 6.6827C13.4014 6.9536 13.2757 8.2113 12.3517 8.5987L9.9972 9.5861L9.8361 9.6583C9.0366 10.0399 8.3731 10.7089 8.0031 11.5138L6.9377 13.8341L6.8488 13.9943C6.3971 14.7003 5.39 14.7669 5.0734 14.1115L5.0158 13.9601L4.2815 11.3205C4.1485 10.8435 3.8277 10.4679 3.3879 10.2677L3.1916 10.1935L0.5783 9.3712C-0.2801 9.1005 -0.155 7.8418 0.7688 7.4542L3.1242 6.4679C3.9412 6.1253 4.632 5.4846 5.0402 4.6983L5.1184 4.5392L6.1838 2.2198ZM6.2004 4.88C5.652 6.0736 4.6394 7.0538 3.4279 7.5616L1.5295 8.3565L3.719 9.046C4.5745 9.3157 5.2059 9.9689 5.4465 10.8331L6.0608 13.0431L6.9201 11.174C7.4685 9.9802 8.4821 9.0001 9.6935 8.4923L11.591 7.6964L9.4025 7.0069C8.547 6.7373 7.9156 6.085 7.675 5.2208L7.0598 3.0099L6.2004 4.88ZM12.7072 0.214C12.8295 -0.052 13.198 -0.0764 13.2687 0.1769L13.6193 1.4396C13.6415 1.5192 13.7005 1.5797 13.7795 1.6046L15.0285 1.9982C15.2795 2.0772 15.243 2.4445 14.9728 2.5577L13.6281 3.1212C13.5431 3.1568 13.4722 3.226 13.4338 3.3097L12.8254 4.6349C12.703 4.9009 12.3344 4.9245 12.2638 4.671L11.9123 3.4093C11.8901 3.3296 11.8319 3.2691 11.7531 3.2442L10.5031 2.8507C10.2522 2.7715 10.2888 2.4045 10.5588 2.2911L11.9035 1.7267C11.9884 1.6911 12.0593 1.6228 12.0978 1.5392L12.7072 0.214Z"/></svg>';
    var ENH_SVG_BUSY = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle size-4 text-foreground-subtle" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
    var ENH_SVG_WARN = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:0 0 auto"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
    /* v469 本卡内选框（issue #477）：旧实现只取卡内第一个输入节点——假设的现场（仅夹具构造过）是布局
     * 切换后残留的隐藏旧编辑器排在前面，读到的是空草稿。选取只在**本卡内**进行，不外扩到页面：按几何
     * 就近取页面内输入框会选中相邻分栏的那一个，把别栏草稿发给模型再写回去（首轮审查夹具实证）。次序：
     * ①实例自己绑定的输入框（协调器按本 pane 选定的 composer）可见即用它 → ②卡内首个可见节点（矩形
     * 宽高均 >0；不看 visibility/opacity，口径窄于协调器 candidateVisible，只在绑定输入框不在卡内的
     * 短窗口走到）→ ③卡内没有可见节点时回到绑定的输入框（编辑器被按设计折叠时草稿仍在）→ ④卡内首个
     * 隐藏节点。绑定输入框刚被折叠、新输入框已可见的切换窗口里走②，不再读旧框的空草稿。卡内没有
     * 候选就是没有，调用方如实提示。 */
    function enhanceInputVisible(el) {
      try { var r = el.getBoundingClientRect(); return !!(r && r.width > 0 && r.height > 0); } catch (e) { return false; }
    }
    function enhanceInputNode() {
      var list = [], input = null, own = false, i;
      try { list = cardCache && cardCache.isConnected ? cardCache.querySelectorAll(ENHANCE_INPUT_SEL) : []; } catch (e) { }
      for (i = 0; i < list.length; i++) if (list[i] === composer) {   // ①可见即用；不可见先记下，③再回到它
        if (enhanceInputVisible(list[i])) return composer;
        own = true;
      }
      for (i = 0; i < list.length && !input; i++) if (enhanceInputVisible(list[i])) input = list[i];   // ②
      if (!input && own) return composer;   // ③
      if (!input && list.length) input = list[0];   // ④
      return input || null;
    }
    /* → { input, api }：api 仅在桥 ready 且桥对象在时非空。宿主 E2ELexicalInputBridgePlugin 在编辑器
     * 根节点缺失或不匹配时会回退绑到页面第一个同 testid 节点并覆盖其上已有的桥——本卡节点的桥可能
     * 因此被别的编辑器覆盖或摘除；据 4.0.0 包内代码静态阅读推断（未实测），之后只有该编辑器根节点
     * 重建才重挂（报告者反馈重启后恢复）。调用方按 input/api 的有无分别提示，不再并成「先输入内容」。 */
    function enhanceInputResolve() {
      var input = enhanceInputNode(), api = null;
      if (input && input.getAttribute("data-e2e-lexical-bridge") === "ready") { try { api = input.__zcodeLexicalInputE2E || null; } catch (e) { api = null; } }
      return { input: input, api: api };
    }
    function enhanceInputApi() { return enhanceInputResolve().api; }
    function enhanceSetPhase(p) {
      enhancePhase = p;
      var b = enhanceBtnCache;
      if (b) b.__zuPhase = "";   // 强制下一拍外观同步
      enhancePromptBtn();
    }
    function enhanceWarn(text) {
      enhanceWarnText = String(text || "");
      if (enhanceWarnTimer) { clearTimeout(enhanceWarnTimer); enhanceWarnTimer = 0; }
      if (enhanceWarnText) {
        enhanceWarnTimer = setTimeout(function () {
          enhanceWarnTimer = 0;
          if (inactive()) return;
          enhanceWarnText = "";
          enhanceSetPhase(enhancePhase);
        }, ENHANCE_WARN_MS);
      }
      enhanceSetPhase(enhancePhase);
    }
    function onEnhanceClick() {
      if (inactive()) return;
      if (enhancePhase === "enhancing") {
        if (enhanceSettled) return;   // 写入已提交，等待编辑器状态确认，不再接受取消
        /* v344.1 增强中再点 = 取消：置 settled 丢弃迟到回包（不再应用结果），通知主进程
         * abort 在途请求（prompt-enhance-cancel，fire-and-forget），静默恢复初始可点击态。 */
        enhanceSettled = true;
        if (enhanceWaitTimer) { clearTimeout(enhanceWaitTimer); enhanceWaitTimer = 0; }
        if (enhanceInFlightId) pluginRequest("prompt-enhance-cancel", { requestId: enhanceInFlightId });
        forgetPluginRequest(enhanceInFlightId);
      enhanceInFlightId = "";   // 清身份键：R1 的迟到回包被 finish 身份门丢弃，不误入后续请求槽位
        enhanceOriginal = "";
        enhanceSid = "";
        enhanceSetPhase("idle");
        return;
      }
      if (enhancePhase === "undo") {   // v350.1 撤销相位已删除（用户拍板去掉该状态展示）：理论不可达，兜底回初始态
        if (enhanceTimer) { clearTimeout(enhanceTimer); enhanceTimer = 0; }
        enhanceSetPhase("idle");
        return;
      }
      /* v469 读取失败分流（issue #477）：找不到节点 / 桥未就绪 / 读取抛错 / 桥读空 / 真空草稿各给真实
       * 提示，旧实现五种状态并成同一句「先输入内容再增强」——输入框里有字却被告知没输入。 */
      var pick = enhanceInputResolve();
      if (!pick.input) { enhanceWarn(L("未找到当前输入框，暂不能增强", "Input box not found; cannot enhance yet")); return; }
      if (!pick.api) { enhanceWarn(L("输入框暂不可读，请重试；仍不行时完全重启 ZCode", "Input box not readable; retry, or fully restart ZCode if it persists")); return; }
      var api = pick.api;
      var draft = "";
      try { draft = String(api.getText() || ""); } catch (e) { enhanceWarn(L("读取草稿失败，请重试", "Failed to read the draft; try again")); return; }
      if (!draft.trim()) {
        /* 桥读回为空而节点自身 DOM 有字：桥错绑到别的（空）编辑器，或输入法组合尚未提交的瞬态，
         * 不是用户没输入。只比是否为空，不解析、不外发节点文本。 */
        var shown = "";
        try { shown = String(pick.input.textContent || ""); } catch (e) { }
        enhanceWarn(shown.trim() ? L("未能读取输入框里的草稿，请重试；仍不行时完全重启 ZCode", "Could not read the draft; retry, or fully restart ZCode if it persists")
          : L("先输入内容再增强", "Type a prompt to enhance first"));
        return;
      }
      if (draft.length > 20000) { enhanceWarn(L("草稿过长（上限 20000 字符）", "Draft exceeds the 20000-character limit")); return; }   // 主进程同值预检
      var providerId = (quotaSelection && quotaSelection.providerId) ? quotaSelection.providerId : (quotaProvider || "");
      var modelId = (quotaSelection && quotaSelection.modelId) ? quotaSelection.modelId : (quotaModel || "");
      var ep = state.pluginUpdate && state.pluginUpdate.enhanceProvider;
      if (!ep || ep.capability !== 1) { enhanceWarn(L("请完全重启 ZCode 以加载增强配置支持", "Fully restart ZCode to load enhancement settings support")); return; }
      if (ep.mode === "custom" && ep.available !== true) {
        /* issue #440：win32 平台门（v357）下 available 恒 false——「完全重启」文案方向误导
         * （重启不会解除平台限制），按 platformLimited 如实提示，与设置页 EP 分区同口径。 */
        enhanceWarn(ep.platformLimited
          ? L("当前平台暂不支持自定义增强供应商", "Custom enhancement providers are not supported on this platform")
          : L("请完全重启 ZCode 以加载增强配置支持", "Fully restart ZCode to load enhancement settings support"));
        return;
      }
      if (ep.unreadable) { enhanceWarn(L("增强配置文件不可读，请检查权限", "Enhancement settings unreadable; check permissions")); return; }
      var useCustom = ep.mode === "custom";
      if (!useCustom && (!providerId || !modelId)) { enhanceWarn(L("未识别当前模型，暂不能增强", "Current model not identified")); return; }
      if (useCustom && (!ep.model || !ep.baseUrl)) { enhanceWarn(L("请先配置增强供应商和模型", "Configure the enhancement provider and model first")); return; }
      enhanceSid = enhanceCurSid();
      enhanceScopeKey = enhanceCurrentScope();
      if (!enhanceSid || !enhanceScopeKey) { enhanceWarn(L("未识别当前会话，暂不能增强", "Current session not identified")); return; }
      enhanceOriginalState = "";
      try {
        if (typeof api.getEditorState === "function" && typeof api.setEditorStateJson === "function") enhanceOriginalState = JSON.stringify(api.getEditorState());
      } catch (e) { enhanceWarn(L("无法保存草稿状态", "Cannot preserve draft state")); return; }
      if (enhanceOriginalState && /"type"\s*:\s*"prompt-mention"/.test(enhanceOriginalState) || !enhanceOriginalState && /\]\((?:file|plugin|skill|agent):\/\//.test(draft)) {
        enhanceOriginalState = "";
        enhanceWarn(L("草稿含引用，暂不能安全增强", "Cannot safely enhance a draft with mentions")); return;
      }
      enhanceOriginal = draft;
      if (enhanceTimer) { clearTimeout(enhanceTimer); enhanceTimer = 0; }
      if (enhanceWarnTimer) { clearTimeout(enhanceWarnTimer); enhanceWarnTimer = 0; }
      enhanceWarnText = "";
      enhanceSetPhase("enhancing");
      enhanceSettled = false;
      /* v344.1 回执身份门：只有「当前在途那笔」的回包才允许消费——取消/还原后的迟到
       * 回包、被新请求覆盖的旧回包（相邻生成的竞态）一律在此丢弃，不再误入新请求的槽位。 */
      var myId = "";
      var finish = function (fn) {
        if (enhanceSettled || inactive()) return;
        /* 身份不匹配（R1 迟到回包落在 R2 在途之后）只丢弃本回包——enhanceSettled 闩的属主
         * 已是 R2，误置会把 R2 的回包与 75s 兜底一起闩死（第二轮复审探针实证的回归）。 */
        if (!myId || enhanceInFlightId !== myId) return;
        enhanceSettled = true;
        enhanceInFlightId = "";
        if (enhanceWaitTimer) { clearTimeout(enhanceWaitTimer); enhanceWaitTimer = 0; }
        fn();
      };
      enhanceWaitTimer = setTimeout(function () {
        enhanceWaitTimer = 0;
        if (enhanceInFlightId) pluginRequest("prompt-enhance-cancel", { requestId: enhanceInFlightId });
        forgetPluginRequest(enhanceInFlightId);
        finish(function () {
          enhanceWarn(L("增强超时，请稍后重试", "Enhance timed out"));
          enhanceSetPhase("idle");
        });
      }, ENHANCE_WAIT_MS);
      enhanceStartedAt = Date.now();   // 历史记录 durationMs 起点（含网络等待与重试）
      enhanceInFlightId = "";
      myId = pluginRequest(useCustom ? "prompt-enhance-v2" : "prompt-enhance", useCustom ? { revision: ep.revision, text: draft } : { providerId: providerId, modelId: modelId, text: draft }, function (res) {
        finish(function () {
          if (state.enhanceEnabled === false) { restoreEnhanceBtn(true); return; }
          if (res && res.ok && typeof res.text === "string" && res.text) {
            var apiNow = enhanceInputApi();
            if (enhanceSid !== "" && (enhanceCurSid() !== enhanceSid || !enhanceScopeKey || enhanceCurrentScope() !== enhanceScopeKey)) {   // v344.3：会话已切换（内容比对无法区分的场景）——绝不写进新会话
              enhanceWarn(L("会话已切换，本次结果未应用", "Session changed; the result was not applied"));
              enhanceSetPhase("idle");
              return;
            }
            var current = "", currentState = "", readOk = true;
            try {
              current = apiNow ? String(apiNow.getText() || "") : "";
              if (enhanceOriginalState && apiNow && typeof apiNow.getEditorState === "function") currentState = JSON.stringify(apiNow.getEditorState());
            } catch (e) { readOk = false; }
            if (!apiNow || !readOk) {   // 回包时输入框已不在本卡、桥不可用或读取抛错：不是草稿变了，如实提示且不写入
              enhanceWarn(L("输入框暂不可读，本次结果未应用", "Input box not readable; the result was not applied"));
              enhanceSetPhase("idle");
              return;
            }
            if (current !== draft || (enhanceOriginalState && currentState !== enhanceOriginalState)) {   // 回填前快照比对：用户已编辑不覆盖
              enhanceWarn(L("草稿已变化，未覆盖你的最新内容", "Draft changed; your latest edits were kept"));
              enhanceSetPhase("idle");
              return;
            }
            try { apiNow.setText(res.text); } catch (e) {
              enhanceWarn(L("写回输入框失败", "Failed to write back"));
              enhanceSetPhase("idle");
              return;
            }
              /* Lexical editor.update 异步提交；下一任务读取已提交状态，不能同步判失败。 */
              enhanceTimer = setTimeout(function () {
                enhanceTimer = 0;
                if (inactive() || state.enhanceEnabled === false) return;
                if (enhanceCurSid() !== enhanceSid || !enhanceScopeKey || enhanceCurrentScope() !== enhanceScopeKey) {
                  enhanceOriginal = ""; enhanceSid = "";
                  enhanceSetPhase("idle");
                  return;
                }
                var committed = "";
                try { committed = String(apiNow.getText() || ""); } catch (e) { }
                /* 换行归一后再比对：模型回包可能含 CRLF，宿主 E2E 桥读回时规范化为 LF，
                 * 逐字比对会恒不等→误报「写回失败或草稿已变化」（文本实际已替换）。 */
                if (enhanceInputApi() !== apiNow || committed.replace(/\r\n/g, "\n") !== res.text.replace(/\r\n/g, "\n")) {
                  enhanceWarn(L("写回输入框失败或草稿已变化", "Write failed or draft changed"));
                  enhanceSetPhase("idle");
                  return;
                }
                /* v350.1 撤销相位已删除：应用成功即记录历史并回初始态（不再展示 20s 撤销窗） */
                enhanceSetPhase("idle");
                if (typeof enhanceHistoryAdd === "function") enhanceHistoryAdd({ requestId: myId, source: "chat", providerName: useCustom ? (ep.providerId || "custom") : providerId, modelId: useCustom ? ep.model : modelId, originalText: enhanceOriginal, enhancedText: res.text, usage: res.usage || null, createdAt: new Date().toISOString(), durationMs: Date.now() - (enhanceStartedAt || Date.now()) });
              }, 0);
          } else {
            /* kind 转可读文案；主进程不回传上游错误正文（仅 status/ kind），error 字段只承载
             * 插件自身的原因短语。kind 优先走 kindMap（i18n 层），error 兜底承载插件/主进程
             * 短语——issue #429 起 plan_auth/balance 不带 error 短语，靠 kindMap 本地化；
             * 旧渲染端读新 kind 落 error 原文或 kind 串，热重载后即本地化。 */
            if (res && res.kind === "cancelled") { enhanceSetPhase("idle"); return; }   // 取消回包静默收口（正常路径已被身份门丢弃，此处兜 restore 摘除路径）
            var kindMap = {
              server: L("模型服务返回错误", "Model server error"),
              http: L("模型服务返回错误", "Model server error"),
              bad_request: L("请求被模型服务拒绝", "Rejected by model service"),
              path: L("服务端点不存在", "Endpoint not found"),
              rate: L("请求过于频繁，稍后再试", "Rate limited; try later"),
              balance: L("套餐额度或资源包不足，无法增强", "Insufficient plan quota or resource pack"),
              plan_auth: L("当前套餐暂不支持增强（无可用的对话凭据）", "This plan has no usable credential; enhancement unavailable"),
              auth: L("凭据无效或已过期", "Credential invalid or expired"),
              timeout: L("增强请求超时", "Enhance timed out"),
              network: L("网络请求失败", "Network request failed"),
              parse: L("响应解析失败", "Bad response"),
              empty: L("模型返回为空", "Empty completion"),
              unsupported: L("该供应商协议不受支持", "Unsupported provider protocol"),
              provider: L("供应商配置不可用", "Provider config unavailable"),
              unavailable: L("主进程模块未就绪，请完全重启 ZCode", "Main-process module not ready; fully restart ZCode"),
              disabled: L("增强功能已关闭", "Prompt enhance is off"),
              invalid_input: L("草稿长度超出范围", "Draft length out of range"),
              invalid_model: L("当前模型不可用", "Current model unavailable"),
            };
            /* 主进程个别 error 短语与 kind 归并后的 kindMap 语义不同（第一轮 review）：providerId
             * 形状校验失败的 kind invalid_input 会误显「草稿长度超出范围」——按短语先行特判 */
            var errPhrase = res && res.error ? String(res.error) : "";
            var reason = (errPhrase === "invalid provider" ? L("供应商身份无效，请重试", "Invalid provider identity") : "")
              || (res && res.kind && kindMap[res.kind]) || errPhrase || (res && res.kind) || "enhance failed";
            enhanceWarn(L("增强失败：", "Enhance failed: ") + reason);
            enhanceSetPhase("idle");
          }
        });
      });
      enhanceInFlightId = myId;

    }
    /* v417：增强历史两处「设置」入口（悬停面板 footer / 全量面板 header）的实例侧执行体——
     * panel/gear/activateSettingsSec 是本闭包私有，01 分片的文档级壳层不可直接引用（曾
     * ReferenceError 被事件分发吞掉静默失效）。挂到入口按钮 __zuOpenEnhSettings 供壳层分发
     * （chip.__zuOpenSub 先例），增强按钮右键菜单同路径复用本函数。 */
    function openEnhSettings() {
      if (inactive()) return;
      hideEnhanceTip();
      closeEnhanceHistoryFull();
      if (!panel.classList.contains("open")) gear.click();
      activateSettingsSec("enhance-provider");
      var nav = panel.querySelector('.zu-navitem[data-sec="enhance-provider"]');
      if (nav) nav.focus();
    }
    function enhancePromptBtn() {
      if (inactive() || state.enhanceEnabled === false) { restoreEnhanceBtn(true); return; }
      var btn = null;
      try { btn = (cardCache && cardCache.isConnected) ? cardCache.querySelector(ENHANCE_ANCHOR_SEL) : null; } catch (e) { }
      if (!btn || !btn.parentElement) {   // 模型 chip 缺位（罕见分支）：回退用量圆环
        try { btn = (ctxBtnCache && ctxBtnCache.isConnected) ? ctxBtnCache : (cardCache ? cardCache.querySelector(ZU_CTX_TRIGGER) : null); } catch (e) { }
      }
      if (!btn || !btn.parentElement) { restoreEnhanceBtn(); return; }
      var wrap = btn.parentElement;
      var b = enhanceBtnCache;
      if (!b || !b.isConnected || b.parentElement !== wrap) {
        if (b && b.isConnected) b.remove();
        b = null;
        for (var i = 0; i < wrap.children.length; i++) {   // 复用热更/重建遗留同类节点，避免双按钮
          if (wrap.children[i].classList && wrap.children[i].classList.contains("zu-enhance")) { b = wrap.children[i]; break; }
        }
        if (!b) {
          b = document.createElement("button");
          b.type = "button";
          b.className = "zu-enhance";
          b.addEventListener("click", onEnhanceClick);
          b.addEventListener("contextmenu", function (e) {
            e.preventDefault(); e.stopPropagation();
            openEnhSettings();
          });
          /* v344 悬停 tooltip（rstTip 同款）：Esc 键盘可达契约 + focus/blur 对齐 */
          b.addEventListener("mouseenter", function () { var bT = this; zuChipHoverArm(bT, function () { showEnhanceTip(bT); }); });   // v440：悬停门槛（路过不弹）
          b.addEventListener("mouseleave", function () { zuChipHoverDisarm(b); scheduleEnhHide(); });   // 延迟收起：给移入历史面板留时间
          b.addEventListener("focus", function () { showEnhanceTip(this); });
          /* v468（issue #476）：失焦收面板只服务键盘路径。点过按钮后焦点留在按钮上，再去点面板里的「设置」等
           * 按钮——mousedown 把焦点移走，blur 抢在 click 之前把面板收走，click 落到下方页面（issue #474 速度 chip 齿轮同款）。
           * 指针还停在面板上时失焦不收（移开由面板 mouseleave 延迟收起接管）。 */
          b.addEventListener("blur", function () {
            try { if (typeof enhanceTip !== "undefined" && enhanceTip && typeof enhanceTip.matches === "function" && enhanceTip.matches(":hover")) return; } catch (eHover) { }
            hideEnhanceTip();
          });
          b.addEventListener("keydown", function (e) { if (e.key === "Escape") hideEnhanceTip(); });
        }
        enhanceBtnCache = b;
      }
      /* v417：钩子每次对账都刷新（复用的旧节点可能带旧代闭包，壳层分发前以 inactive() 自卫） */
      b.__zuOpenEnhSettings = openEnhSettings;
      /* 位置兜回：紧贴锚点左侧；回退锚（用量圆环）场景额度 chip（.zu-quota）恒贴圆环，
       * 按钮落在 chip 更左侧（跳过连续 quota 段找插入点），两节点同锚互不挤位振荡。
       * 真实 DOM 的 children 是 HTMLCollection（无 indexOf），只能 length+下标遍历。 */
      var ref = btn;
      for (var ri = wrap.children.length - 1; ri >= 0; ri--) {
        if (wrap.children[ri] !== btn) continue;
        for (var rj = ri - 1; rj >= 0; rj--) {
          var pc = wrap.children[rj];
          if (pc.classList && pc.classList.contains("zu-quota")) ref = pc;
          else break;
        }
        break;
      }
      if (b.nextElementSibling !== ref) wrap.insertBefore(b, ref);
      if (enhanceTipFor && !enhanceTipFor.isConnected) hideEnhanceTip();   // 按钮被宿主重建 detach 的兜底收起（v135 徽标同款）
      var phase = enhanceWarnText ? "warn" : enhancePhase;
      if (b.__zuPhase !== phase) {   // 签名幂等：相位没变不重写，busy 旋转/悬停不被打断
        b.__zuPhase = phase;
        b.innerHTML = phase === "enhancing" ? ENH_SVG_BUSY : (phase === "warn" ? ENH_SVG_WARN : ENH_SVG_STAR);
        b.classList.toggle("zu-ewarn", phase === "warn");
        var label = phase === "enhancing" ? L("增强中…", "Enhancing…")
          : phase === "warn" ? enhanceWarnText
          : L("增强提示词", "Enhance prompt");
        b.setAttribute("aria-label", label);
        b.setAttribute("aria-busy", phase === "enhancing" ? "true" : "false");
        b.__zuEnhTip = label;   // tooltip 文案包（showEnhanceTip 读，实例闭包算好双语/相位）
        if (enhanceTipFor === b) showEnhanceTip(b);   // 悬停中相位变化：文案跟随（额度 chip 同款）
      }
    }
    function restoreEnhanceBtn(alsoCancel) {
      /* 关闭功能或销毁实例时取消在途请求并丢弃迟到回包。暂时没有锚点时只摘 DOM，
       * 仍由 finish 的会话与草稿校验决定是否回填。 */
      if (alsoCancel && enhanceInFlightId && !enhanceSettled) {
        pluginRequest("prompt-enhance-cancel", { requestId: enhanceInFlightId });
      }
      if (alsoCancel) { forgetPluginRequest(enhanceInFlightId); enhanceSettled = true; }
      if (alsoCancel) {
        if (enhanceTimer) { clearTimeout(enhanceTimer); enhanceTimer = 0; }
        if (enhanceWaitTimer) { clearTimeout(enhanceWaitTimer); enhanceWaitTimer = 0; }
        if (enhanceWarnTimer) { clearTimeout(enhanceWarnTimer); enhanceWarnTimer = 0; }
        enhancePhase = "idle"; enhanceWarnText = "";
        enhanceOriginal = ""; enhanceSid = ""; enhanceScopeKey = ""; enhanceOriginalState = ""; enhanceSettled = true; enhanceInFlightId = "";
      }
      /* 临时摘除保留 original/sid：迟到成功回包经身份门+守卫回填后，历史采集与会话守卫仍完整。 */
      if (enhanceTipFor === enhanceBtnCache) hideEnhanceTip();   // 在显 tooltip 随按钮一起收（v135 徽标同款）
      if (enhanceBtnCache && enhanceBtnCache.isConnected) enhanceBtnCache.remove();
      enhanceBtnCache = null;
    }

    /* ---------- v124 Git 状态 chip：始终挂在工具行左侧操作区 ----------
     * 样式移植 cc-pretty-statusline 的 git 段：⎇ 分支 ↑N ↓N (+插入行 -删除行 ?未跟踪文件)。
     * 数据：模块级 gitViewFor(scope.workspacePath)（主进程旁路查询推送）；本 pane 的 scope 为远端
     * （identity 非空）/ 未知 / 非仓库 / 无 git 时不挂载。稳定性同 v92：自有节点插在 React children
     * 之间（React 既不复用也不清理外来节点），位置由 render/heavy 双 reapply 兜回；内容签名幂等。 */
    function gitMount() {
      if (!cardCache) return null;
      function live(el) {
        /* v308：幽灵判定改走 ghostOf（120ms TTL WeakMap 缓存）——裸 inGhostSubtree 逐祖先
         * getComputedStyle 强制样式重算，而 enhanceGitChip 在每次 render/heavy 都跑 gitMount，
         * 任务切换的 React 重挂风暴里样式树最脏，实测每次切换聚集 ~48ms 主线程阻塞
         * （CDP CPU 采样归因：inGhostSubtree 436ms/9.4s 几乎全部经 gitMount；ghostOf 缓存路径仅 2ms）。
         * 缓存语义与 track 每帧的 ghostOf(composer) 同款（v115 契约），设置页幽灵壳收敛延迟 ≤120ms。 */
        if (!el.isConnected || !el.parentElement || ghostOf(el)) return false;
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
      var wt = worktreeFor(scope.sid);   // specs/worktree-branch.md：受管 worktree 会话按 cwd 查询/显示（workspacePath 是项目主目录）
      var gp = wt ? wt.cwd : scope.workspacePath;
      var v = gitViewFor(gp);
      return v ? { path: gp, st: v.st, stale: v.stale, wt: wt } : null;
    }
    /* v409：游离检出分支令牌单源（chip L0 与响应式 L2 共用，防两处手抄漂移；aria 用更细文案不走此函数） */
    function gitBranchToken(st, view) {
      return st.detached ? (view.wt ? "worktree" : "HEAD") : st.noCommits ? L("初始", "init") : String(st.branch || "HEAD");
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
      var name = gitBranchToken(st, view);   // v409：worktree 游离检出显 worktree（v410 改小写；specs/worktree-branch.md）
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
    function gitChipAria(st, stale, wt) {
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
      var s = L("Git 分支 ", "Git branch ") + (st.detached ? (wt ? L("worktree（游离检出）", "worktree (detached)") : "HEAD") : st.noCommits ? L("初始（尚无首次提交）", "init (no initial commit yet)") : st.branch);
      if (st.ahead > 0) s += L("，领先 ", ", ahead ") + st.ahead;
      if (st.behind > 0) s += L("，落后 ", ", behind ") + st.behind;
      if (st.ins > 0 || st.del > 0) s += L("，改动 +", ", changes +") + (st.ins | 0) + " -" + (st.del | 0);
      if (st.untracked > 0) s += L("，未跟踪 ", ", untracked ") + st.untracked;
      if ((st.conflicts | 0) > 0) s += L("，! " + st.conflicts + " 个冲突文件", ", ! " + st.conflicts + " conflicted files");
      if (st.op) s += L("，进行中操作：", ", git operation: ") + gitOpLabel(st.op);
      if (stale) s += L("，数据已过期", ", data stale");
      return s;
    }
    /* ---------- v383 Git chip 工具栏四级响应式（specs/git-chip-responsive.md）----------
     * 候选/测量/选级只读数据与几何，不重查 Git、不动 Tooltip；L0/L1 复用 gitChipHtml 同串
     * （L1 靠既有 zu-compact CSS 收起分支名与 ↑↓）。绝不拼接 ins/del 之类假汇总数字；
     * 风险（冲突/操作中/过期）在摘要以下以短标与状态点保留，aria 恒全量。 */
    function gitDotCls(st, stale) {
      if ((st.conflicts | 0) > 0) return "zu-git-dot-r";
      if (stale) return "zu-git-dot-n";   // 未知优先于变更：过期数据不能冒充最新状态
      /* 操作中（rebase/merge 等）与有变更同为黄：L3/L3I 丢弃操作词后点色是唯一视觉语义，
       * 绿点会伪造干净态（v383 review M1） */
      if (st.op || (st.ins | 0) > 0 || (st.del | 0) > 0 || (st.untracked | 0) > 0) return "zu-git-dot-y";
      return "zu-git-dot-g";
    }
    function gitCandidates(view) {
      var st = view.st, stale = view.stale;
      var full = gitChipHtml(view);
      if (st.kind === "multi") {   // v96 multi 独立摘要：仓库数+确认冲突+失败仓+过期保留，「M改」折叠进 ⋯
        var agg = gitMultiAgg(st);
        var mdot = (agg.conflict > 0 || agg.failed > 0) ? "zu-git-dot-r" : (agg.staleAny || stale) ? "zu-git-dot-n" : (agg.op > 0 || agg.changed > 0) ? "zu-git-dot-y" : "zu-git-dot-g";
        var mdotEl = '<span class="zu-git-dot ' + mdot + '"></span>';
        var mrisk = "";
        if (agg.conflict > 0) mrisk += '<span class="zu-git-conflict">!' + agg.conflict + "</span>";   // 仓库个数不缩写（与 L0/aria 同口径）
        if (agg.failed > 0) mrisk += '<span class="zu-git-warn">' + agg.failed + L("失败", " failed") + "</span>";   // 失败仓保留文字（裸数字无语义），摘要不得显得全部查询成功
        if (stale) mrisk += '<span class="zu-git-warn">' + L("过期", "stale") + "</span>";
        var l2m = ZU_GIT_MULTI_ICON + '<span class="zu-git-name">' + agg.total + L("仓", " repos") + "</span>" + mrisk +
          (agg.changed > 0 ? '<span class="zu-git-more">⋯</span>' : "");
        return { L0: full, L1: full, L2: l2m, L3: ZU_GIT_MULTI_ICON + mdotEl + mrisk, L3I: ZU_GIT_MULTI_ICON + mdotEl };
      }
      var name = gitBranchToken(st, view);   // v409：单源令牌，与 gitChipHtml 恒一致
      var shown = name.length > 18 ? name.slice(0, 16) + "…" : name;   // 截断与转义同 L0，全名进 Tooltip
      var nums = [];
      if (st.ins > 0) nums.push('<span class="zu-git-ins">+' + gitNum(st.ins) + "</span>");
      if (st.del > 0) nums.push('<span class="zu-git-del">-' + gitNum(st.del) + "</span>");
      var work = "";
      if (nums.length) work = nums.join(" ");
      else if (st.untracked > 0) work = '<span class="zu-git-unt">?' + gitNum(st.untracked) + "</span>";
      else work = '<span class="zu-git-name">' + gitEsc(shown) + "</span>";   // 无任何改动时显示分支名（分支名收纳不触发 ⋯，见 hidden 注释）
      /* 段序对齐 spec 示例（⎇ !2 +764 -164 变基中 过期 ⋯）：冲突 → 工作段 → 操作 → 过期 → ⋯ */
      var hidden = (nums.length && st.untracked > 0) || (st.ahead > 0 || st.behind > 0);   // ⋯=有工作区/同步信息被折叠（?N 被行数段并入、↑↓ 收起）；分支名收纳是 L2 预期行为不触发（任务书 `⎇ ?4` 示例）
      var l2 = ZU_GIT_ICON +
        (((st.conflicts | 0) > 0) ? '<span class="zu-git-conflict">!' + gitNum(st.conflicts) + "</span>" : "") +
        work +
        (st.op ? '<span class="zu-git-op">' + gitEsc(gitOpLabel(st.op)) + "</span>" : "") +   // rebase/merge 中是风险态，摘要保留
        (stale ? '<span class="zu-git-warn">' + L("过期", "stale") + "</span>" : "") +
        (hidden ? '<span class="zu-git-more">⋯</span>' : "");
      var dotEl = '<span class="zu-git-dot ' + gitDotCls(st, stale) + '"></span>';
      var l3r = (((st.conflicts | 0) > 0) ? '<span class="zu-git-conflict">!' + gitNum(st.conflicts) + "</span>" : "") +
        (stale ? '<span class="zu-git-warn">' + L("过期", "stale") + "</span>" : "");
      var l3s = ZU_GIT_ICON + dotEl + l3r;   // L3 不再带操作词（点色与 Tooltip 承载）
      return { L0: full, L1: full, L2: l2, L3: l3s, L3I: ZU_GIT_ICON + dotEl };
    }
    var GIT_ORDER = ["L0", "L1", "L2", "L3", "L3I"];
    var GIT_HYST = 20;   // 展开迟滞（与 QUOTA_HYST 同带）；收缩即时
    if (typeof window !== "undefined") {
      var gitSeamInst = {};   // 实例级令牌：缝按实例创建覆盖赋值，dispose 据此只删本实例（最后创建者）的缝
      window.__zusageGitFns = {
        gitCandidates: gitCandidates, gitDotCls: gitDotCls, gitMeasureAvail: function (mount, chip) { return gitMeasureAvail(mount, chip); },
        pickQuotaDisplayLevel: pickQuotaDisplayLevel,
        GIT_ORDER: GIT_ORDER, GIT_HYST: GIT_HYST,
        __zuInst: gitSeamInst,
        all: function () {
          return {
            gitCandidates: gitCandidates, gitDotCls: gitDotCls, gitMeasureAvail: gitMeasureAvail,
            pickQuotaDisplayLevel: pickQuotaDisplayLevel, GIT_ORDER: GIT_ORDER, GIT_HYST: GIT_HYST
          };
        }
      };
    }
    /* 候选自然宽：克隆 chip 离屏实测（沿用旧探测模式），按 等级|html|语言|字号 缓存——
     * 数据/语言/字号不变时不重复克隆（render+heavy 双对账点高频）；缓存超界整体重置防长会话无界增长。 */
    function gitMeasureWidth(html, levelKey, multi, chip) {
      var fs = "";
      try { fs = (chip && chip.isConnected && typeof getComputedStyle === "function") ? (getComputedStyle(chip).fontSize || "") : ""; } catch (e) { }
      var key = levelKey + "|" + html + "|" + state.lang + "|" + fs;
      if (gitWidthCache && Object.prototype.hasOwnProperty.call(gitWidthCache, key)) return gitWidthCache[key];
      if (gitWidthCache === null) gitWidthCache = {};
      var n = 0;
      for (var k in gitWidthCache) { n++; if (n > 64) { gitWidthCache = {}; break; } }
      var probe = null;
      try {
        probe = chip.cloneNode(true);
        probe.className = "zu-git" + (multi ? " zu-git-multi" : "") +
          (levelKey === "L1" ? " zu-compact" : "") + (levelKey === "L2" ? " zu-l2" : "") +
          (levelKey === "L3" ? " zu-l3" : "") + (levelKey === "L3I" ? " zu-l3i" : "");
        probe.setAttribute("aria-hidden", "true");
        probe.inert = true;
        probe.style.position = "fixed";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.width = "max-content";
        probe.style.maxWidth = "none";
        probe.innerHTML = html;
        document.body.appendChild(probe);
        var w = probe.getBoundingClientRect().width || 0;
        if (w > 0) gitWidthCache[key] = w;   // 0=探针瞬态失败（clone 异常/脱离布局）：不缓存，下一拍重试
        return w;
      } catch (e) { return 0; }
      finally { if (probe) probe.remove(); }
    }
    /* Git chip 可用宽度；null=无法可靠测量（VM stub/未标定结构/内容自撑行）→ fail-safe 保持 L0/L1。
     * 标定结构（真实 CDP 取证 2026-11-17）：leadA 是 flex-1 min-w-0（宽度=row−trailing−gap，窗口驱动），
     * leadC 是 shrink-0；avail = min(leadA.w, row.w−trail.w−gap) − (leadC.w − chipW_in_leadC)。
     * chip 变级/摘除时 chipW 自消，avail 与 chip 当前形态无关（反自指，无额度 chip v382 首版黑洞）。
     * 未标定结构（无 leading-actions/content 对、内容自撑行、rect 异常）一律返回 null，
     * 上层 fail-safe 走 gitChipCompactLegacy 旧两态（宿主 compact 强制 + 32px 迟滞），绝不猜测收窄。 */
    function gitMeasureAvail(mount, chip) {
      if (!cardCache || !mount) return null;
      var row = toolbarRowOf(cardCache);
      if (!row || !(row.clientWidth > 0) || typeof row.getBoundingClientRect !== "function") return null;
      var hasAttr = function (el, a) { return !!(el && el.hasAttribute && el.hasAttribute(a)); };
      var content = hasAttr(mount.wrap, "data-composer-leading-content") ? mount.wrap : row.querySelector("[data-composer-leading-content]");
      var available = content && content.parentElement && hasAttr(content.parentElement, "data-composer-leading-actions") ? content.parentElement : row.querySelector("[data-composer-leading-actions]");
      var trailing = row.querySelector("[data-composer-trailing-actions]");
      var gap = 0;
      try { gap = parseFloat(getComputedStyle(row).columnGap) || 0; } catch (e) { }
      var chipW = 0, chipLive = !!(chip && chip.isConnected);
      if (chipLive) { try { chipW = chip.getBoundingClientRect().width || 0; } catch (e) { chipW = 0; } }
      if (hasAttr(content, "data-composer-leading-content") && hasAttr(available, "data-composer-leading-actions")) {
        var aR = null, cR = null, rR = null, tR = null;
        try {
          aR = available.getBoundingClientRect();
          cR = content.getBoundingClientRect();
          rR = row.getBoundingClientRect();
          if (trailing && hasAttr(trailing, "data-composer-trailing-actions")) tR = trailing.getBoundingClientRect();
        } catch (e) { return null; }
        if (!aR || !isFinite(aR.width) || !(aR.width > 1)) return null;   // 内容自撑行（inline 单行输入等）：未标定 fail-safe
        if (!cR || !isFinite(cR.width) || !rR || !isFinite(rR.width)) return null;
        var room = aR.width;
        if (tR && isFinite(tR.width)) room = Math.min(room, rR.width - (tR.width + gap));
        var used = cR.width - ((chipLive && chip.parentElement === content) ? chipW : 0);
        var avail = room - used;
        /* 几何签名：同几何零重复计算（rect 读取仍在——签名输入即读数，此处省的是算术）；hasChip 入签防摘除态读数污染 */
        var sig = Math.round(room) + "|" + Math.round(used) + "|" + (chipLive ? 1 : 0);
        if (sig === gitAvailSig) return gitAvailVal;
        gitAvailSig = sig;
        gitAvailVal = isFinite(avail) ? avail : 0;
        return gitAvailVal;
      }
      /* 未标定结构（无 leading-actions+content 对）一律返回 null：行内子元素可伸缩，
       * 「行宽 − 子元素求和」会得到 ≈0 的伪读数（pill 夹具实测），多级收缩会误判 hidden；
       * 上层 fail-safe 走 gitChipCompactLegacy 旧两态，绝不猜测收窄或隐藏。 */
      return null;
    }
    function onGitEnter() { showGitTip(this); }
    /* v420：点击优先唤起宿主原生 Git 胶囊弹层（specs/git-chip-host-sync.md §2）。胶囊只在同 pane
     * 的 composer 里找：wantedEl 可能是编辑器等 pane 内节点（真实宿主实测 wantedEl.querySelector
     * 查不到 composer 状态区），沿 readPaneScope 同款上溯到 data-session-id 的 pane 根、校验 sid
     * 后再查——干净仓库宿主不渲染胶囊、旧宿主无该结构、胶囊不可见时一律回退原有立即刷新链；
     * 命中则派发 pointer 全序列合成点击交宿主 Radix 开面板（与原生胶囊点击行为一致：只开面板
     * 不刷新），坐标取胶囊中心，全程 try 包裹不外抛。 */
    function findNativeGitCapsule() {
      try {
        var root = wantedEl, guard = 0;
        while (root && !(root.hasAttribute && root.hasAttribute("data-session-id")) && guard++ < 24) root = root.parentElement;
        if (!root || !root.isConnected || !root.querySelector) return null;
        if (root.getAttribute("data-session-id") !== pickedSid) return null;   // 不跨 pane 借胶囊
        var el = root.querySelector('[data-status-capsule="git"]');
        if (!el || !el.getClientRects || !el.getClientRects().length) return null;
        return el;
      } catch (e) { return null; }
    }
    function openNativeGitCapsule(el) {
      try {
        hideGitTip();
        var r = el.getBoundingClientRect();
        var o = { bubbles: true, cancelable: true, view: window, button: 0,
          clientX: Math.round((r.left || 0) + (r.width || 0) / 2), clientY: Math.round((r.top || 0) + (r.height || 0) / 2) };
        var PE = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
        el.dispatchEvent(new PE("pointerdown", o));
        el.dispatchEvent(new MouseEvent("mousedown", o));
        el.dispatchEvent(new PE("pointerup", o));
        el.dispatchEvent(new MouseEvent("mouseup", o));
        el.dispatchEvent(new MouseEvent("click", o));
        scheduleCapsuleReanchor();   // v422：等 Radix 挂载后把弹层迁到 chip 正上方
      } catch (e) { }
    }
    /* v422 弹层定位迁移（specs/git-chip-host-sync.md §2）：Radix 把弹层锚在原生胶囊、位置写
     * wrapper 内联 transform（强改会被其定位引擎覆盖回）；改用独立 translate 属性——与
     * transform 叠乘、Radix 从不写它、无拉锯——水平居中于 chip、底缘距 chip 顶 8px、视口
     * 钳边 8px。Radix 挂载是异步 React 渲染，0 起步五档重试；令牌去重防连点竞争；胶囊
     * 自身点击（非 chip 路径）不经此链，定位保持原生。 */
    var capsuleReanchorToken = 0;
    function findCapsulePopperWrapper() {
      try {
        var content = document.querySelector('[data-status-capsule-content="git"]');
        if (!content) return null;
        var wrap = content.closest ? content.closest("[data-radix-popper-content-wrapper]") : null;
        if (wrap) return wrap;
        var p = content.parentElement;
        return p && p.hasAttribute && p.hasAttribute("data-radix-popper-content-wrapper") ? p : null;
      } catch (e) { return null; }
    }
    function applyCapsuleReanchor(chip, wrap) {
      try {
        var cr = chip.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
        if (!cr || !wr || !(cr.width > 0) || !(wr.width > 0)) return;
        var left = Math.min(Math.max(8, cr.left + cr.width / 2 - wr.width / 2), Math.max(8, window.innerWidth - wr.width - 8));
        var top = Math.max(8, cr.top - 8 - wr.height);
        wrap.style.translate = Math.round(left - wr.left) + "px " + Math.round(top - wr.top) + "px";
      } catch (e) { }
    }
    function scheduleCapsuleReanchor() {
      var chip = gitChipCache;
      if (!chip || !chip.isConnected) return;
      var token = ++capsuleReanchorToken, delays = [60, 120, 240, 480, 800], i = 0;
      var step = function () {
        if (token !== capsuleReanchorToken) return;   // 连点：新一次点击接管
        var wrap = findCapsulePopperWrapper();
        if (wrap) { applyCapsuleReanchor(chip, wrap); return; }
        if (i < delays.length) setTimeout(step, delays[i++]);
      };
      step();
    }
    function onGitClick(e) {
      e.preventDefault();
      e.stopPropagation();
      var capsule = findNativeGitCapsule();
      if (capsule) { openNativeGitCapsule(capsule); return; }
      if (gitRefreshRequestId) return;
      var scope = readPaneScope(wantedEl, pickedSid, pid);
      var wt = scope ? worktreeFor(scope.sid) : null;   // specs/worktree-branch.md：刷新请求同样按覆写路径
      var targetPath = scope ? (wt ? wt.cwd : scope.workspacePath) : "";
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
        var summary = view ? gitChipAria(view.st, view.stale, view.wt) : L("当前目录没有 Git 状态", "No Git status for this directory");
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
        var currentStatus = currentView ? gitChipAria(currentView.st, currentView.stale, currentView.wt) : "";
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
    /* v383：旧两态探测保留为「未标定结构」回退（v146 夹具实证：无 leading-actions 的宿主行
     * 子元素可伸缩，行内求和口径会把 avail 压到 ≈0，多级收缩会把 chip 误判成 hidden）——
     * 多级响应只在已标定结构（leading-actions+leading-content 对，真实宿主 CDP 取证）启用；
     * 未标定结构维持 v124 以来的行为：宿主 compact 强制紧凑 + 32px 恢复迟滞探测，绝不隐藏。 */
    function gitChipCompactLegacy(btn, chip, html, mount) {
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
        if (gitTipFor === chip && !state.devKeepTip) hideGitTip();   // v424 开发者常驻：React 重建 chip 不收（弹层滞留待重悬停刷新）
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
          chip.addEventListener("mouseenter", function () { var gT = this; zuChipHoverArm(gT, function () { onGitEnter.call(gT); }); });   // v440：悬停门槛（路过不弹；focus 走 onGitEnter 原样即时）
          chip.addEventListener("mouseleave", function () { zuChipHoverDisarm(chip); hideGitTipSoon(); });
          chip.addEventListener("focus", onGitEnter);
          chip.addEventListener("blur", function () { if (!state.devKeepTip) hideGitTip(); });   // v423 开发者常驻不自动收
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
      else mis = wrap.lastElementChild !== chip && !(sysmonChipCache && wrap.lastElementChild === sysmonChipCache);   // v356：容忍系统状态 chip 收尾（[锚][速率][git][sysmon] 收敛，防两 chip 逐拍拉锯）
      if (mis) wrap.insertBefore(chip, slotNode);
      var gitLiveText = gitChipAria(view.st, view.stale, view.wt);
      if (ariaLiveState.__zuGitLive !== gitLiveText) {
        ariaLiveState.__zuGitLive = gitLiveText;
        ariaLiveState.textContent = ariaLiveState.__zuGitLive || ariaLiveState.__zuQuotaLive || "";
      }
      syncCtxLite(chip, bar.classList.contains("zu-light"));
      chip.__zuGit = view;
      /* v383 四级响应式：按前导区真实可用宽度选级；hidden=极限降级摘除节点（__zuGit 数据保留，
       * 恢复宽度经持久等级迟滞回展），不遮挡原生控件。宿主 compact 时候选序封顶 L1（不再展开全名）。 */
      var multi = view.st.kind === "multi";
      var cands = gitCandidates(view);
      var hostCompact = btn.getAttribute("data-composer-compact") === "true";
      var avail = null;
      try { avail = gitMeasureAvail(mount, chip); } catch (e) { avail = null; }
      var level;
      if (avail === null) level = (hostCompact || gitChipCompactLegacy(btn, chip, cands.L0, mount)) ? "L1" : "L0";   // 未标定 fail-safe：完整保留旧两态行为（绝不猜测收窄或隐藏）
      else {
        level = pickQuotaDisplayLevel(   // 泛型选级与额度 chip 同款：从最完整到最简、展开迟滞、hidden 兜底
          hostCompact ? ["L1", "L2", "L3", "L3I"] : GIT_ORDER,
          avail,
          function (key) { return gitMeasureWidth(cands[key], key, multi, chip); },
          gitLevel, GIT_HYST);
      }
      gitLevel = level;
      if (level === "hidden") {
        if (gitTipFor === chip && !state.devKeepTip) hideGitTip();   // v424 开发者常驻：极窄摘 chip 不收弹层
        try { chip.remove(); } catch (e) { }
        gitChipCache = null;
        ariaLiveState.__zuGitLive = "";
        ariaLiveState.textContent = ariaLiveState.__zuQuotaLive || "";
        return;
      }
      var html = cands[level];
      var mAgg = multi ? gitMultiAgg(view.st) : null;
      var cls = "zu-git" + (level === "L1" ? " zu-compact" : "") +
        (level === "L2" ? " zu-l2" : "") + (level === "L3" ? " zu-l3" : "") + (level === "L3I" ? " zu-l3i" : "") +
        (multi ? " zu-git-multi" : "") + (mAgg && mAgg.conflict > 0 ? " zu-conflict" : "");   // 形态类（L1 既有 CSS 收起分支名/L2+ 换摘要串）+ 确认冲突 → 冲突段转红；过期走文字徽章不降透明度
      var sig = cls + "|" + html + "|" + state.lang;
      var busy = chip.classList.contains("zu-gbusy");
      if (chip.__zuSig !== sig) {   // 幂等：内容不变时不重建 chip
        chip.__zuSig = sig;
        chip.className = cls + (busy ? " zu-gbusy" : "");
        chip.setAttribute("aria-label", gitChipAria(view.st, view.stale, view.wt));
        chip.innerHTML = html;
      }
      chip.setAttribute("data-zusage-glevel", level);   // React 不动 data-*；诊断/测试读级
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

    /* ---------- v356 系统状态 chip（精简模式工具行，issue #338）：git chip 同款模板。
     * 仅 compact 主题挂载（default 条面已有格、pill 面条内格仍走条面）；收敛位
     * [锚][速率][git][sysmon]：git 在=紧跟其后，git 缺位=落 git 锚位（容忍速率相邻）。
     * 面串与条面格共用 sysmonFaceHtml（format:"auto" 在此解析为 compact 档——工具行
     * 空间比条面紧，不量宽，显式档用户自担）。点击=立即刷新+弹完整 Tooltip。 */
    var sysmonChipCache = null;
    function sysmonChipMounted() { return !!(sysmonChipCache && sysmonChipCache.isConnected); }
    function sysmonChipAria() {
      var parts = [], f = sysFrame;
      if (state.sysmonCfg.metrics.cpu && f && f.cpu && f.cpu.state === "ok") parts.push("CPU " + Math.round(f.cpu.pct) + "%");
      if (state.sysmonCfg.metrics.mem && f && f.mem && f.mem.state === "ok") parts.push(L("内存", "Memory") + " " + Math.round(f.mem.pct) + "%");
      if (state.sysmonCfg.metrics.disk && f && f.disk && f.disk.state === "ok") {
        var v = sysVolPick(f.disk.vols);
        if (v && typeof v.avail === "number") parts.push(L("磁盘可用", "disk free") + " " + sysFmtBytes(v.avail));
      }
      return L("系统状态", "System status") + (parts.length ? "：" + parts.join("，") : "");
    }
    function onSysChipEnter() { if (this && this.isConnected) showSysTip(this); }
    function onSysChipKey(e) {
      if (e && e.key === "Enter") { e.preventDefault(); if (this) this.click(); }
      else if (e && e.key === " ") e.preventDefault();
    }
    function onSysChipKeyup(e) { if (e && e.key === " ") { e.preventDefault(); if (this) this.click(); } }   // v356 review：Space 激活对齐 git chip 的 keydown+keyup 对（aria-keyshortcuts 已声明）
    function onSysChipClick() {
      try { pluginRequest("sysmon-refresh", {}); } catch (e) { }
      if (this && this.isConnected) showSysTip(this);
    }
    function syncSysmonChip() {
      if (inactive()) { restoreSysmonChip(); return; }
      if (state.theme !== "compact" || !state.show.sysmon ||
        !(state.sysmonCfg.metrics.cpu || state.sysmonCfg.metrics.mem || state.sysmonCfg.metrics.disk)) {
        restoreSysmonChip(); return;
      }
      /* 本地性判定与条面格同源（lastView.remote/not_local 由帧级证据驱动，fail-closed）：
       * readPaneScope 依赖渲染桥——无桥环境（QA harness/桥降级）恒 null 会让 chip 永不挂载，
       * 而条面格在同环境正常渲染，两 gate 必须同源。 */
      var vLocal = lastView && !lastView.remote && !lastView.not_local;
      if (!vLocal) { restoreSysmonChip(); return; }   // 远端/不在本地库：不显示本机指标
      var mount = null;
      try { mount = gitMount(); } catch (e) { }
      if (!mount) { restoreSysmonChip(); return; }
      var wrap = mount.wrap;
      var chip = sysmonChipCache;
      if (!chip || !chip.isConnected) {
        if (sysTipFor === chip) hideSysTip();
        chip = null;
        for (var i = 0; i < wrap.children.length; i++) {   // 复用热更/重建遗留节点，避免双 chip
          if (wrap.children[i].classList && wrap.children[i].classList.contains("zu-sysm")) { chip = wrap.children[i]; break; }
        }
        if (!chip) {
          chip = document.createElement("span");
          chip.className = "zu-sysm";
          chip.setAttribute("role", "button");
          chip.setAttribute("aria-keyshortcuts", "Enter Space");
          chip.tabIndex = 0;
        }
        if (!chip.__zuWired) {   // v356 review：新建与遗留采纳统一接线（遗留节点可能来自旧代际未挂监听）
          chip.__zuWired = true;
          chip.addEventListener("mouseenter", function () { var sT = this; zuChipHoverArm(sT, function () { onSysChipEnter.call(sT); }); });   // v440：悬停门槛（路过不弹；focus 走 onSysChipEnter 原样即时）
          chip.addEventListener("mouseleave", function () { zuChipHoverDisarm(chip); hideSysTipSoon(); });
          chip.addEventListener("focus", onSysChipEnter);
          /* v362：焦点移入浮层内部（点/Tab 到 ⓘ）不算离开——blur 先于 click 把浮层关掉，
           * ⓘ 的 click 永远收不到（Windows 上 button mousedown 即移焦，macOS 恰好幸存） */
          chip.addEventListener("blur", function (e) {
            if (e.relatedTarget && sysTip.contains(e.relatedTarget)) return;
            hideSysTip();
          });
          chip.addEventListener("keydown", onSysChipKey);
          chip.addEventListener("keyup", onSysChipKeyup);
          chip.addEventListener("click", onSysChipClick);
        }
        sysmonChipCache = chip;
      }
      var face = sysmonFaceHtml(state.sysmonCfg, sysFrame, state.sysmonCfg.format === "auto" ? "compact" : state.sysmonCfg.format);
      if (!face) { restoreSysmonChip(); return; }   // 监控全关（运行中被关）兜底
      var gitIn = !!(gitChipCache && gitChipCache.isConnected);
      var slotNode = mount.after ? mount.after.nextElementSibling : null;
      var mis;
      if (!chip.isConnected) mis = true;   // 首挂必须插入（同 git 首挂契约）
      else if (gitIn) mis = chip.previousElementSibling !== gitChipCache;   // git 在：紧跟其后（判位与插入方向一致，防逐拍空转）
      else mis = slotNode !== chip && !(tpsChipCache && slotNode === tpsChipCache);   // git 缺位：占锚后位，容忍速率 chip 相邻（git chip 同款约定，review M1：旧谓词与插入方向互斥永不收敛）
      if (mis) {
        if (gitIn) wrap.insertBefore(chip, gitChipCache.nextElementSibling);
        else wrap.insertBefore(chip, slotNode);
      }
      syncCtxLite(chip, bar.classList.contains("zu-light"));
      var sig = "zu-sysm|" + face + "|" + state.lang;
      if (chip.__zuSig !== sig) {
        chip.__zuSig = sig;
        chip.className = "zu-sysm";
        chip.setAttribute("aria-label", sysmonChipAria());
        chip.innerHTML = face;
      }
      if (sysTipFor === chip) showSysTip(chip);   // 悬停中帧刷新：内容跟随
      sysmonWantRecalc();
    }
    function restoreSysmonChip() {
      if (!sysmonChipCache) return;
      if (sysTipFor === sysmonChipCache) hideSysTip();
      try { sysmonChipCache.remove(); } catch (e) { }
      sysmonChipCache = null;
      sysmonWantRecalc();
    }

    /* ---------- v421 压缩分隔线统计标注（宿主「上下文已压缩」分隔线下方多行标注块） ----------
     * 宿主 v4 协议的 compact marker 载荷本就带 tokensBefore/tokensAfter 与行级 createdAt
     * （zcode-protocol-v4/rows.ts），但分隔线只渲染文案、数字与时间不进 DOM。数据源改走
     * 插件本地库：zusage.py 把 query_source='compact' 行（成功一次=时间线一条 success
     * 分隔线，按 started_at 序与 DOM 第 k 条一一对应）及压缩前后 main_turn 输入、压缩后
     * 首请求缓存三列推入快照顶层 compactions（{sid:[{ts,b,a,cr,cw}]}，粘性回填见 00 分片；
     * 数字为插件 ctx 口径，a 含 system+工具模式，不冒充宿主 marker 载荷值）。
     * DOM 锚=[data-row-kind="timelineMarker"][data-marker-type="compact"][data-status="success"]，
     * 标注块独立成行：宿主中央 pill 是 inline-flex 行向（icon+label 一行），行尾平拼会让
     * min-w-0 收缩把 label 和数字任意折断——只给 pill 补 flex-wrap:wrap（React 无 style
     * 属性不回收该内联样式，摘除时还原），标注 span flex-basis:100% 独占一行换到 label
     * 下方居中多行（v437 三行：日期+序数与间隔／变化水位%+减少／压缩消耗+耗时+
     * 执行模型，<br> 分行，缺样本整行省略，整块 nowrap 防窄窗折断句中）；
     * 带 data-zusage-cmp 标记 + __zuSig 签名幂等；
     * render 数据点 + heavy 对账点 + body MutationObserver（与弹层压缩按钮同款 rAF 去抖）
     * 三路兜回。作用域=本实例 pane（composer 祖先链 v4-session-pane-*，分栏各标各的，
     * 找不到 pane 退化全文档查、按 pane 过滤兜底）；记录缺条目的分隔线不标并摘除多余
     * 标注（诚实降级）。数字格式按用户规格固定千分位逗号（不走 fmt 的万/亿·K/M 档），
     * 日期随 zusage3.lang。 */
    function cmpNum(n) {
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    /* 宿主同款时长格式（与 05 分片 formatWorkDuration 同算法同约定，该函数在轮播闭包
     * 不可跨用；conversationWorkDuration.ts：totalSeconds=max(1,round(ms/1000))，非零
     * 单位入列、至多两段，中文值与单位间插空格）。压缩耗时秒级、距上次间隔时/天级共用。 */
    function cmpDur(ms) {
      var totalSeconds = Math.max(1, Math.round((Number(ms) || 0) / 1000));
      var d = Math.floor(totalSeconds / 86400);
      var h = Math.floor((totalSeconds % 86400) / 3600);
      var m = Math.floor((totalSeconds % 3600) / 60);
      var s = totalSeconds % 60;
      var en = state.lang === "en";
      var units = [[d, "天", "d"], [h, "时", "h"], [m, "分", "m"], [s, "秒", "s"]];
      var parts = [];
      for (var i = 0; i < units.length; i++) {
        if (units[i][0] > 0 || (i === 3 && !parts.length)) {
          parts.push(en ? units[i][0] + units[i][2] : units[i][0] + " " + units[i][1]);
        }
      }
      return parts.slice(0, 2).join(" ");
    }
    function cmpDate(ts) {
      var d = new Date(Number(ts) || 0);
      if (!d.getTime()) return "";
      var p2 = function (x) { return (x < 10 ? "0" : "") + x; };
      var hm = p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
      if (state.lang === "en") {
        var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return MON[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear() + " " + hm;
      }
      return d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月 " + d.getDate() + " 日 " + hm;
    }
    function compSuffixHtml(r, idx, list) {
      /* v437 三行版式（v428 曾四行，缓存四项行经爸爸点名去除）：日期+序数与间隔／
       * 变化(水位%)+减少／压缩消耗+耗时+执行模型，缺样本的段整体省行（诚实降级）；
       * 整块 nowrap 防窄窗折断句中。水位窗口与上下文按钮同优先级（ctxOv 手动覆盖 >
       * nativeCtxVal 原生 aria 总量 > 快照 context_window），窗口未知退回纯数字。 */
      var lines = [];
      var meta = [];
      var date = cmpDate(r.ts);
      if (date) meta.push(date);
      if (list && idx >= 0) {
        meta.push(L("第 " + (idx + 1) + " 次", "#" + (idx + 1)));
        var prev = idx > 0 && list[idx - 1];
        if (prev && prev.ts && r.ts > prev.ts) {
          meta.push(L("距上次 " + cmpDur(r.ts - prev.ts), cmpDur(r.ts - prev.ts) + " since last"));
        }
      }
      if (meta.length) lines.push(meta.join(" · "));
      if (r.b > 0 && r.a > 0) {
        var drop = Math.max(0, r.b - r.a);
        var pct = (drop / r.b * 100).toFixed(2);
        var win = parseInt(state.ctxOv, 10) || nativeCtxVal || (state.data && state.data.context_window) || 0;
        var chg = win > 0
          ? Math.round(r.b / win * 100) + "%(" + cmpNum(r.b) + ")→" + Math.round(r.a / win * 100) + "%(" + cmpNum(r.a) + ")"
          : cmpNum(r.b) + "→" + cmpNum(r.a);
        var chgEn = win > 0
          ? Math.round(r.b / win * 100) + "% (" + cmpNum(r.b) + ")→" + Math.round(r.a / win * 100) + "% (" + cmpNum(r.a) + ")"
          : cmpNum(r.b) + "→" + cmpNum(r.a);
        /* v448：去「上下文变化：/Context: 」开头（用户规格）——宿主分隔线本身已表达压缩语义，
         * 数值行直接以水位变化起句；减少/压缩消耗/耗时措辞不变。 */
        lines.push(L(chg + " · 减少：" + cmpNum(drop) + " Token（" + pct + "%）",
          chgEn + " · Reduced: " + cmpNum(drop) + " tokens (" + pct + "%)"));
      }
      /* v437：缓存四项行（未缓存输入/读取/创建/命中率）整行去除——快照 cr/cw 字段保留
       * （zusage 侧不删，未来费用/首答估算仍需未缓存口径），仅前端不渲染。 */
      var op = [];
      if (r.out > 0) op.push(L("压缩消耗 " + cmpNum(r.out) + " Token", "Compaction cost " + cmpNum(r.out) + " tokens"));   // v434：措辞（用户规格）——out 是压缩请求自身的消耗，旧词「摘要」易误读为摘要正文长度
      if (r.dur > 0) op.push(L("耗时 " + cmpDur(r.dur), "Took " + cmpDur(r.dur)));
      if (r.alt) op.push(L("由 " + gitEsc(r.alt) + " 执行", "by " + gitEsc(r.alt)));   // v433：model_id 来自 DB（自定义名可含 HTML），与其余转义链同规；走外层 IIFE 的 gitEsc——本工厂作用域没有 esc（v445：此前裸引 esc 抛 ReferenceError，自带 alt 的记录起标注全缺）
      if (op.length) lines.push(op.join(" · "));
      return lines.join("<br>");
    }
    function syncCompactionRows() {
      if (inactive()) return;
      if (typeof mobileMode !== "undefined" && mobileMode) return;
      try {
        var recs = null;
        var sid = pickedSid || instSid || "";
        if (lastCompactions && typeof lastCompactions === "object") recs = lastCompactions[sid];
        var rows = document.querySelectorAll('[data-row-kind="timelineMarker"][data-marker-type="compact"][data-status="success"]');
        /* pane 作用域：与 readQuotaSelection 同款祖先链爬升；锚缺失（composer 未绑定）
         * 时退化为全文档查询（单会话窗口无歧义），多分栏下各实例按各自 pane 过滤。 */
        var pane = null;
        var anchor = wantedEl && wantedEl.isConnected ? wantedEl : composer;
        for (var anc = anchor; anc && anc !== document.body; anc = anc.parentElement) {
          var tid = anc.getAttribute && anc.getAttribute("data-testid");
          if (tid && tid.indexOf("v4-session-pane-") === 0) { pane = anc; break; }
        }
        var k = 0;   // 只累计 pane 内分隔线，分栏并存时序号不串
        for (var i = 0; i < rows.length; i++) {
          if (pane && !pane.contains(rows[i])) continue;
          /* v421 开关门控：state.cmpAnn 关=rec 恒空 → 走下方摘除分支（标注撤下即时生效） */
          var row = rows[i], rec = (state.cmpAnn ? recs : null) && recs[k++];
          var old = row.querySelector("span[data-zusage-cmp]");
          if (!rec || !rec.ts) {
            if (old && old.parentNode) {
              old.parentNode.style.flexWrap = "";   // 还原宿主 pill 单行布局
              old.parentNode.removeChild(old);
            }
            continue;
          }
          var html = compSuffixHtml(rec, k - 1, recs);
          if (old && old.__zuSig === html) continue;
          if (old && old.parentNode) old.parentNode.removeChild(old);
          /* 中央 pill=行内唯一 <span> 直接子级（两侧是装饰细线 div），label 之后追加 */
          var pill = null;
          for (var c = 0; c < row.children.length; c++) {
            if (row.children[c].tagName === "SPAN") { pill = row.children[c]; break; }
          }
          if (!pill) continue;
          var span = document.createElement("span");
          span.setAttribute("data-zusage-cmp", "1");
          span.__zuSig = html;
          span.innerHTML = html;   // 日期/数值由格式化函数拼出；唯一的 DB 文本是执行模型名 alt，已在 compSuffixHtml 过 gitEsc
          span.style.cssText = "flex:0 0 100%;font-size:12px;opacity:.78;text-align:center;line-height:1.5;white-space:nowrap;";
          pill.style.flexWrap = "wrap";   // 行向 pill 放行换行：标注块落到 label 下（先设再挂避免闪帧）
          pill.appendChild(span);
        }
      } catch (e) { FATAL.cmpErr = String((e && e.stack) || e); }
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
          /* v316 视格重做：18px 收缩双箭头 SVG + 文案 textNode，flex+gap 8px 图文整体
           * 居中（匿名文本项同样参与 gap 对齐）；SVG 用 currentColor 随主题换装。
           * 图标走常量串 innerHTML 无注入面；文案经 L() 后以文本节点写入，不用
           * innerHTML 整体拼（VM 桩不解析 HTML，tests 读 children.textContent 断言）。 */
          b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
            '<path d="M5 11h14"/><path d="M5 13h14"/><path d="M12 2v6"/><path d="m9 5 3 3 3-3"/>' +
            '<path d="M12 22v-6"/><path d="m9 19 3-3 3 3"/></svg>';
          b.appendChild(document.createTextNode(L("压缩上下文", "Compact context")));
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
    /* ---------- v361 重置卡事件触发软强刷：窗口恢复可见（最小化/遮挡切回）即拉新 ----------
     * 悬停徽标的查看即拉新在 01 分片 showRstTip 入口，同一 quota-poke action；主进程
     * pokeReset 自带 30s 防抖、inFlight 与 auth 冻结守卫，多窗口各自上报只在主进程收敛。
     * 徽标关闭（reset_badge_enabled=false）时不发——独立链已停，无需唤醒。 */
    listenGlobal(document, "visibilitychange", function () {
      if (inactive() || !state.resetBadge) return;
      if (document.visibilityState === "visible") pluginRequest("quota-poke");
    });

