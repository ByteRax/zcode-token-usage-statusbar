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
      renderWorkflowCards();   // v332：工作流 run 卡 chip DOM 对账点（React 重建卡片后兜回；数据点在 render 尾部）
      renderRunningSubagentItems();   // v333：状态面板 Agents 行 chip DOM 对账点（React 高频重写 elapsed 后兜回）
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
       * 已 dispose 实例的 tooltip——趁 wantedEl/composer 尚在按 pane 根摘净。
       * v334：工作流卡（.zu-wfrun）与状态面板行（.zu-substat）chip 同性质同摘。 */
      try {
        var srr = subRowPaneRoot();
        if (srr) {
          var staleChips = srr.querySelectorAll(".zu-subrate,.zu-wfrun,.zu-substat");
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