  // ── UI ──
  /* CSS 分两段：手机私有布局（手写本分片）+ 照抄桌面段（构建期注入占位符）。
   * __ZM_CELL_CSS__：格结构规则（.it/.sep/.k/.v/.dim/.eb），从桌面 06 分片
   *   zm-cell-css 锚点区提取，选择器改写 .zm-root 前缀——桌面调格样式重建即同步。
   * __ZM_BAND_CSS__：TPS 色档（zm-band- 与 zm-tone- 两族的深色组 + .zm-light 浅色组），
   *   从桌面 06 分片 zm-band-css 锚点区的单类 color 规则展开，色值与桌面逐字节同源。 */
  var CSS = "\
.zm-root{position:fixed;bottom:104px;left:50%;transform:translateX(-50%);z-index:2147483000;font:12px/1.5 -apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:var(--color-foreground,#e8eaed);}\
.zm-bar{display:flex;gap:1px;align-items:center;}\
" +
  "__ZM_CELL_CSS__" +
  "__ZM_BAND_CSS__" +
"\
.zm-idle{color:var(--color-foreground-subtle,#9aa0a6);font-size:11px;padding:2px 6px;}\
/* 内嵌输入卡形态：去掉药丸表面 = 桌面默认档「输入卡内一行」；超宽横滚不截断 */\
.zm-root.zm-inline{position:relative;left:auto;bottom:auto;transform:none;width:100%;max-width:none;display:flex;align-items:center;padding:0;margin:0;background:none;border:0;border-radius:0;box-shadow:none;font:inherit;color:inherit;pointer-events:auto;}\
.zm-root.zm-inline .zm-bar{width:100%;max-width:none;background:transparent;border:0;box-shadow:none;border-radius:0;padding:0 26px 0 0;overflow-x:auto;scrollbar-width:none;}\
.zm-root.zm-inline .zm-bar::-webkit-scrollbar{display:none;}\
/* 设置按钮 + 「状态栏显示」面板（向上展开，不遮挡输入框） */\
.zm-gear,.zu-gear{flex:0 0 auto;align-self:center;width:26px;height:26px;border:0;background:transparent;color:var(--color-foreground-subtle,#a1a1a1);border-radius:7px;cursor:pointer;font:inherit;line-height:1;display:inline-flex;align-items:center;justify-content:center;}\
.zm-inline .zu-gear{position:absolute;right:0;top:50%;transform:translateY(-50%);background:var(--color-background,#1a1a1a);}\
.zm-inline .zu-gear:hover{color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07));}\
.zu-gear:hover{background:var(--color-hover,rgba(255,255,255,.08));color:var(--color-foreground,#e9edf4);}\
.zm-root .ico{display:block;width:1em;height:1em;}\
.zm-root .zm-bar.zm-just-start{justify-content:flex-start;}\
.zm-root .zm-bar.zm-just-end{justify-content:flex-end;}\
.zm-root .zm-bar.zm-just-between{justify-content:space-between;}\
/* 「状态栏显示」面板：桌面 .panel/.zu-settings 子集照抄（popover 底、毛玻璃、圆角、\
 * 行 hover、checkbox 品牌色、标题/版本胶囊/关闭钮）——面板骨架与桌面结构性差异较大\
 * （桌面是分区导航 + 双语重建，此处是单页静态），保留手写不进构建提取。 */\
.zm-panel{position:fixed;display:none;flex-direction:column;gap:4px;min-width:280px;max-width:480px;max-height:72vh;overflow:auto;padding:12px 14px;background:var(--color-card,rgba(19,22,30,.97));backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:12px;color:var(--color-foreground,#c6cdd9);font:13px/1.6 ui-sans-serif,system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.35);z-index:2147483647;white-space:normal;}\
.zm-panel.zm-open{display:flex;}\
.zm-panel label{display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:5px 8px;margin:0 -8px;border-radius:8px;transition:background-color .12s ease-out;}\
.zm-panel label:hover{background:var(--color-hover,rgba(255,255,255,.06));}\
.zm-panel input[type=checkbox]{accent-color:var(--color-brand,#57c7ff);margin-top:3px;}\
.zm-panel label em{font-style:normal;color:var(--color-foreground-subtle,#6f7989);display:block;}\
.zm-panel .cap{color:var(--color-foreground-subtlest,#6b7484);margin:4px 0 2px;font-size:12px;letter-spacing:.08em;}\
.zm-panel .phead{font-weight:600;color:var(--color-foreground,#eef2f8);font-size:16px;margin-bottom:7px;display:flex;align-items:center;gap:8px;}\
.zm-panel .pver{color:var(--color-brand,#57c7ff);font-weight:400;font-size:12px;background:rgba(87,199,255,.12);border-radius:999px;padding:1px 8px;}\
.zm-panel .hr{border-top:1px solid var(--color-border,rgba(255,255,255,.08));margin:5px 0;}\
.zm-panel .zu-theme-title{padding:10px 0 0;font-weight:500;}\
.zm-panel .zu-theme-options{display:flex;gap:8px;padding:8px 0;flex-wrap:wrap;}\
.zm-panel .zu-settings-close{position:absolute;top:10px;right:10px;background:none;border:0;font:inherit;color:var(--color-foreground-subtle,#8791a3);cursor:pointer;}\
.zm-panel .zu-settings-close:hover{color:var(--color-foreground,#e9edf4);}\
.zm-dbg{position:fixed;top:52px;right:12px;z-index:2147483000;background:var(--color-popover,rgba(20,21,24,.94));border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:8px;padding:8px 10px;font:11px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre;max-width:340px;max-height:40vh;overflow:auto;}\
.zm-toggle{position:fixed;top:80px;right:12px;z-index:2147483001;width:22px;height:22px;border-radius:50%;background:var(--color-popover,rgba(32,33,36,.9));border:1px solid var(--color-border,rgba(255,255,255,.2));color:var(--color-foreground-subtle,#9aa0a6);font-size:11px;line-height:20px;text-align:center;cursor:pointer;display:none;}\
";
  var root, bar, dbg, toggle;

  /* 锚定输入卡：桌面端状态条挂在输入卡**内部**（mountInCard，工具行之后）。远控页没有
   * 稳定的卡类名，这里从输入框向上找「有圆角 + 有表面（背景/边框）+ 内含按钮」的最近
   * 祖先作为输入卡，把状态条追加为它的最后一个子节点（卡片是纵向 flex，自然排在工具行
   * 下方）。找不到退回 [data-v4-composer-dock-content]（卡片下方），再退回 body 悬浮。 */
  var INLINE_HOST = "[data-v4-composer-dock-content]";
  function findCard() {
    var ta = document.querySelector('[data-testid="chat-input"], textarea, [contenteditable="true"]');
    if (!ta) return null;
    var node = ta, best = null, dock = document.querySelector(INLINE_HOST);
    for (var i = 0; i < 12; i++) {
      node = node.parentElement;
      if (!node || node === document.body || node === dock) break;
      var r = node.getBoundingClientRect();
      if (r.width < 280 || r.height < 50) continue;
      var cs = getComputedStyle(node);
      var radius = parseFloat(cs.borderTopLeftRadius) || 0;
      var bg = cs.backgroundColor || "";
      var surface = (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") || (parseFloat(cs.borderTopWidth) || 0) > 0;
      if (radius >= 8 && surface && node.querySelector("button")) best = node;
    }
    return best;
  }
  /* 浅色/深色判定：取页面实际底色亮度（body → html → 输入卡），挂 .zm-light 让档位色
   * 切到桌面亮色主题的深色值；不依赖 OS 主题（页面主题可独立切换）。 */
  function applyTheme() {
    if (!root) return;
    try {
      var probe = [document.body, document.documentElement, findCard()];
      var lum = -1;
      for (var i = 0; i < probe.length; i++) {
        if (!probe[i]) continue;
        var bg = getComputedStyle(probe[i]).backgroundColor || "";
        var m = bg.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
        if (!m) continue;
        var a = bg.indexOf("rgba") === 0 ? parseFloat(bg.split(",")[3]) : 1;
        if (!(a > 0.5)) continue;
        lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
        break;
      }
      if (lum >= 0) root.classList.toggle("zm-light", lum > 160);
    } catch (e) { }
  }
  function place() {
    if (!root || !document.body) return;
    /* 药丸主题：固定悬浮在 body（桌面药丸同语义），不进输入卡 */
    if ((prefs.theme || "inline") === "pill") {
      if (root.parentElement !== document.body) {
        root.classList.remove("zm-inline");
        document.body.appendChild(root);
      }
      applyTheme();
      return;
    }
    var host = findCard() || document.querySelector(INLINE_HOST);
    if (host) {
      if (root.parentElement !== host) {
        root.classList.add("zm-inline");
        host.appendChild(root);
      }
      applyTheme();
      return;
    }
    if (root.parentElement !== document.body) {
      root.classList.remove("zm-inline");
      document.body.appendChild(root);
    }
    applyTheme();
  }

  /* 显示项行：构建期从桌面 buildPanel() settingRow 锚点（zm-show-rows）提取 data-k 与
   * 中文标题/描述，按下方声明键集过滤——手机 chips 数据源只有这些键（13 分片 mcIds
   * 映射）。桌面新增显示项不自动进手机：先在 13 分片 mcIds 加映射，再在此声明。 */
  /*@zm-show-keys turn,win,proj,today,tools,sub@*/
  var SHOW_ROWS = __ZM_SHOW_ROWS__;
  function syncPanel() {
    panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
      cb.checked = !(prefs.show && prefs.show[cb.dataset.k] === false);
    });
    panel.querySelectorAll("input[name=zm-theme]").forEach(function (r) { r.checked = (prefs.theme || "inline") === r.value; });
    panel.querySelectorAll("input[name=zm-just]").forEach(function (r) { r.checked = (prefs.just || "between") === r.value; });
  }
  /* 主题（内嵌/药丸）与水平对齐（均分/居左/居右）落样式：桌面 state.theme/barJust 同款键 */
  function applyLayout() {
    if (!root || !bar) return;
    var inline = (prefs.theme || "inline") !== "pill";
    root.classList.toggle("zm-inline", inline);
    bar.classList.remove("zm-just-between", "zm-just-start", "zm-just-end");
    bar.classList.add("zm-just-" + (prefs.just || "between"));
    place();
  }
  var gear, panel;
  /* ⚙ 面板打开（bar 内 gear；回退条隐藏后经由桌面面板注入块）：面板挂 body、fixed 定位在锚点旁
   * （卡片 overflow-hidden 会裁掉 absolute 子面板，桌面 v80 迁移到 body+fixed 同因）。 */
  function openPanel() {
    var open = panel.classList.toggle("zm-open");
    if (open) {
      syncPanel();
      if (panel.parentElement !== document.body) document.body.appendChild(panel);
      var r = gear.getBoundingClientRect();
      var pw = panel.offsetWidth || 300, ph = panel.offsetHeight || 260;
      var left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8));
      var top = r.bottom + 6;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    }
  }
  function ensureDom() {
    if (root && document.body.contains(root)) return;
    if (!document.body) return;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.className = "zm-root";
    bar = document.createElement("div");
    bar.className = "zm-bar";
    root.appendChild(bar);
    /* 设置面板：桌面 ⚙「状态条设置」的精简移植——phead+版本胶囊+关闭钮、
     * 「状态条显示」cap、样式/对齐 radio、显示项勾选行（label+em 描述与桌面同文案）。
     * 真值存 localStorage prefs（桌面走宿主 IPC/config，远控页没有这条通道）。 */
    gear = document.createElement("button");
    gear.type = "button";
    gear.className = "zu-gear";
    gear.title = "状态条设置";
    gear.textContent = "\u2699";
    panel = document.createElement("div");
    panel.className = "zm-panel";
    panel.innerHTML =
      '<div class="zu-settings-head"><div class="phead">状态条设置<span class="pver">v' + SCRIPT_VERSION + '</span></div>' +
      '<button type="button" class="zu-settings-close" aria-label="关闭设置">✕</button></div>' +
      '<div class="cap">状态条显示</div>' +
      '<div class="zu-theme-title">状态条样式</div>' +
      '<div class="zu-theme-options" role="radiogroup" aria-label="状态条样式">' +
      '<label><input type="radio" name="zm-theme" value="inline"><span>默认（输入卡内）</span></label>' +
      '<label><input type="radio" name="zm-theme" value="pill"><span>药丸（悬浮）</span></label></div>' +
      '<div class="zu-theme-title">水平对齐</div>' +
      '<div class="zu-theme-options" role="radiogroup" aria-label="水平对齐">' +
      '<label><input type="radio" name="zm-just" value="between"><span>均分对齐</span></label>' +
      '<label><input type="radio" name="zm-just" value="start"><span>居左对齐</span></label>' +
      '<label><input type="radio" name="zm-just" value="end"><span>居右对齐</span></label></div>' +
      '<div class="hr"></div>' +
      SHOW_ROWS;
    panel.querySelector(".zu-settings-close").onclick = function () { panel.classList.remove("zm-open"); };
    panel.querySelectorAll("input[name=zm-theme]").forEach(function (r) {
      r.checked = (prefs.theme || "inline") === r.value;
      r.onchange = function () { prefs.theme = r.value; savePrefs(); applyLayout(); };
    });
    panel.querySelectorAll("input[name=zm-just]").forEach(function (r) {
      r.checked = (prefs.just || "between") === r.value;
      r.onchange = function () { prefs.just = r.value; savePrefs(); applyLayout(); };
    });
    panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
      cb.checked = !(prefs.show && prefs.show[cb.dataset.k] === false);
      cb.onchange = function () {
        prefs.show = prefs.show || {};
        prefs.show[cb.dataset.k] = cb.checked;
        savePrefs();
        render();
      };
    });
    gear.onclick = function (e) { e.stopPropagation(); openPanel(); };
    root.appendChild(panel);
    document.addEventListener("mousedown", function (e) {
      if (!panel || !panel.classList.contains("zm-open")) return;
      if (panel.contains(e.target) || (gear && gear.contains(e.target))) return;
      panel.classList.remove("zm-open");
    }, true);
    document.body.appendChild(root);
    /* 调试面板与 ☰ 钮只在调试变体（DEBUG_BUILD）创建：正式版零调试痕迹，stats 照常收集，
     * 需要排障时改装调试版即可见。 */
    if (DEBUG_BUILD) {
      dbg = document.createElement("div");
      dbg.className = "zm-dbg";
      dbg.style.display = prefs.debug ? "block" : "none";
      dbg.addEventListener("click", function (e) { e.stopPropagation(); });
      toggle = document.createElement("div");
      toggle.className = "zm-toggle";
      toggle.textContent = "☰";
      toggle.title = "zusage";
      toggle.onclick = function () { prefs.debug = !prefs.debug; savePrefs(); dbg.style.display = prefs.debug ? "block" : "none"; renderDebug(); };
      document.body.appendChild(dbg);   // 调试框独立定位（右上角），不随状态条容器移动
      document.body.appendChild(toggle);
    }
    applyLayout();
    renderDebug();
  }

  /* 行内 SVG 图标：构建期从桌面 07 分片 ico() 锚点（zm-ico:id）提取——桌面更新图标
   * 重新构建即同步。声明的 id 集合必须都能在桌面锚点命中，缺失即构建报错。 */
  /*@zm-icons speed,turn,win,today,proj,tools,sub@*/
  var ICONS = __ZM_ICONS__;
  function ico(id) {
    return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[id] || "") + "</svg>";
  }

  /* 与桌面 .it 同构的格：图标（构建提取的桌面同款 SVG）→ .v 主值（600 字重）→ .dim
   * 后缀（「N次 / N轮 N次 / t/s」）→ .eb 错误红徽标。样式来自构建注入的桌面段。 */
  function chip(c) {
    var d = document.createElement("div");
    d.className = "it";
    if (c.detail) d.title = String(c.detail);
    d.innerHTML = ico(c.id);
    var v = document.createElement("span");
    // band（TPS_BANDS 档色）> tone（bad/warn/ok）> 默认前景色；不再无脑套 mute 灰
    v.className = "v" + (c.band ? " zm-band-" + c.band : (c.tone ? " zm-tone-" + c.tone : ""));
    v.textContent = String(c.v || c.value || "–");
    d.appendChild(v);
    if (c.dim) {
      var dim = document.createElement("span");
      dim.className = "dim";
      dim.textContent = String(c.dim);
      d.appendChild(dim);
    }
    if (c.err) {   // 工具错误数：桌面 .eb 红色徽标同款
      var e = document.createElement("span");
      e.className = "eb";
      e.textContent = String(c.err);
      d.appendChild(e);
    }
    return d;
  }
  function sep() {
    var s = document.createElement("span");
    s.className = "sep";
    return s;
  }

  var renderQueued = false;
  /* 从 URL 提取远控会话标识（?sid=...），用于按会话过滤 chips */
  function currentSessionId() {
    try {
      var m = location.search.match(/[?&]sid=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      ensureDom();
      /* 桌面 overlay 已接管渲染：旧 chips 条整体隐藏，⚙/tooltip/设置全在桌面条上 */
      if (overlayReady) {
        if (root) root.style.display = "none";
        renderDebug();
        return;
      }
      if (root) root.style.display = "";
      place();
      /* 主题/对齐落样式（面板 change 时代走 applyLayout，这里兜底帧同步） */
      root.classList.toggle("zm-inline", (prefs.theme || "inline") !== "pill");
      bar.classList.remove("zm-just-between", "zm-just-start", "zm-just-end");
      bar.classList.add("zm-just-" + (prefs.just || "between"));
      if (!bar) return;
      bar.textContent = "";
      /* 「状态栏显示」筛选：缺省全开，只有显式 false 才隐藏 */
      function shown(c) { return !(c && c.id && prefs.show && prefs.show[c.id] === false); }
      // 按远控页面当前会话过滤 chips（bySession 结构）
      var chips = null;
      if (lastChips && lastChips.bySession) {
        var sid = currentSessionId();
        if (sid && lastChips.bySession[sid]) chips = lastChips.bySession[sid];
        else {
          var idle = document.createElement("span");
          idle.className = "zm-idle";
          idle.textContent = sid ? "zusage：会话 " + sid.slice(-8) + " 无数据" : "zusage：无法识别会话";
          bar.appendChild(idle);
          bar.appendChild(gear);
          if (prefs.debug) renderDebug();
          return;
        }
      } else if (lastChips && Array.isArray(lastChips.chips)) {
        chips = lastChips.chips;
      }
      if (!chips || !chips.length) {
        var idle2 = document.createElement("span");
        idle2.className = "zm-idle";
        idle2.textContent = "zusage：已连接，暂无数据";
        bar.appendChild(idle2);
      } else {
        var first = true;
        chips.forEach(function (c) {
          if (!(c && typeof c === "object" && shown(c))) return;
          if (!first) bar.appendChild(sep());   // 桌面 .sep：1px 分隔线
          first = false;
          bar.appendChild(chip(c));
        });
      }
      bar.appendChild(gear);   // 设置按钮恒在行尾（render 重建后重挂）
      if (Date.now() - (lastChips && lastChips.ts || 0) > 30000) bar.style.opacity = ".55";
      else bar.style.opacity = "1";
      if (DEBUG_BUILD) toggle.style.display = "block";   // 调试版：☰ 钮随首帧数据出现
      renderDebug();
    });
  }

  function renderDebug() {
    if (!DEBUG_BUILD || !dbg || !prefs.debug) return;
    dbg.textContent =
      "zusage relay debug\n" +
      "ws(relay) opened : " + stats.wsOpened + "\n" +
      "rpc-frames       : " + stats.relayFrames + "\n" +
      "EventFire parsed : " + stats.decoded + "\n" +
      "zusage frames    : " + stats.magicFrames + "\n" +
      "last update      : " + (stats.lastTs ? new Date(stats.lastTs).toLocaleTimeString() : "–") + "\n" +
      "errors           : " + stats.errors + (stats.lastError ? " (" + stats.lastError + ")" : "") + "\n" +
      "inject           : " + (stats.ranAt || "–") + " v" + SCRIPT_VERSION + "\n" +
      "desktop overlay  : " + (overlayReady ? "已加载（渲染走桌面 overlay.js）" : overlayLoading ? "加载中…" : "未加载（回退旧 chips 条）") + "\n" +
      "ws(all) created  : " + stats.wsAll + (stats.lastWsUrl ? "\nlast ws url      : " + stats.lastWsUrl : "") + "\n" +
      "workers          : " + stats.workers + " (shared " + stats.sharedWorkers + ")" + (stats.lastWorkerUrl ? "\nlast worker url  : " + stats.lastWorkerUrl : "") + "\n" +
      (stats.reloadHint ? "hint             : " + stats.reloadHint + "\n" : "") +
      (stats.wsOpened === 0 ? "⚠ 尚未捕获 relay WebSocket：若 ws(all)>0 且 url 含 ws2 即注入过晚；若 workers>0 即连接在 Worker 内" : "");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { ensureDom(); render(); });
  } else { ensureDom(); render(); }
  // 周期性刷新调试面板（无数据时也显示状态）+ 重挂锚定（React 重渲染会摘节点）
  setInterval(function () {
    try { place(); } catch (e) { }
    try { lateAttachRelays(); } catch (e) { }
    if (sentCfgGen > lastCfgAckGen && Date.now() - lastCfgSendAt > 30000) sendConfig(sentCfgGen);
    renderDebug();
  }, 2000);
  // 注入时序兜底：管理器可能把 @run-at document-start 拖到 interactive/complete 才注入
  // （实测篡改猴测试版 inject=interactive），页面此前的中继 WebSocket 钩不到。8s 后仍零
  // 捕获则自动刷新一次（sessionStorage 防循环），再失败则常驻提示并写进调试面板。
  setTimeout(function () {
    if (stats.wsOpened > 0) return;
    var K = "zusageMobileAutoReload";
    var done = false;
    try { done = sessionStorage.getItem(K) === "1"; } catch (e) {}
    if (!done) {
      try { sessionStorage.setItem(K, "1"); } catch (e) {}
      stats.reloadHint = "未捕获中继连接（注入过晚），正在自动刷新…";
      renderDebug();
      location.reload();
      return;
    }
    stats.reloadHint = "自动刷新后仍未捕获：检查篡改猴开发者模式（edge://extensions）或手动刷新";
    renderDebug();
    try {
      ensureDom();
      if (bar) {
        var idle3 = document.createElement("span");
        idle3.className = "zm-idle";
        idle3.textContent = "zusage：未捕获中继连接（注入过晚），请刷新页面";
        bar.textContent = "";
        bar.appendChild(idle3);
      }
    } catch (e) {}
  }, 8000);
})();
