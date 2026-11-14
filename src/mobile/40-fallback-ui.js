  /* 仅诊断 UI；状态条、设置与 tooltip 全由内嵌桌面 overlay 创建。 */
  var dbg = null, toggle = null, debugStyle = null;
  var heartbeatTimer = 0, hintTimer = 0;
  function ensureDebug() {
    if (!DEBUG_BUILD || dbg || !document.body) return;
    debugStyle = document.createElement("style");
    debugStyle.textContent = ".zm-dbg{position:fixed;top:52px;right:12px;z-index:2147483646;background:var(--color-popover,#202124);color:var(--color-foreground,#e8eaed);border:1px solid var(--color-border,#555);border-radius:8px;padding:8px 10px;font:11px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-width:min(340px,90vw);max-height:40vh;overflow:auto}.zm-toggle{position:fixed;top:20px;right:12px;z-index:2147483647;width:28px;height:28px;border:1px solid var(--color-border,#555);border-radius:6px;background:var(--color-popover,#202124);color:var(--color-foreground,#e8eaed);cursor:pointer}";
    (document.head || document.documentElement).appendChild(debugStyle);
    dbg = document.createElement("div");
    dbg.className = "zm-dbg";
    toggle = document.createElement("button");
    toggle.type = "button"; toggle.className = "zm-toggle";
    toggle.textContent = "☰"; toggle.title = "zusage 调试面板";
    toggle.onclick = function () { prefs.debug = !prefs.debug; savePrefs(); renderDebug(); };
    document.body.appendChild(dbg); document.body.appendChild(toggle);
    renderDebug();
  }
  function renderDebug() {
    if (!DEBUG_BUILD || !dbg) return;
    dbg.style.display = prefs.debug ? "block" : "none";
    if (!prefs.debug) return;
    dbg.textContent = "zusage relay debug\n" +
      "ws(relay) opened : " + stats.wsOpened + "\n" +
      "rpc-frames       : " + stats.relayFrames + "\n" +
      "EventFire parsed : " + stats.decoded + "\n" +
      "zusage frames    : " + stats.magicFrames + "\n" +
      "last update      : " + (stats.lastTs ? new Date(stats.lastTs).toLocaleTimeString() : "–") + "\n" +
      "errors           : " + stats.errors + (stats.lastError ? " (" + stats.lastError + ")" : "") + "\n" +
      "inject           : " + (stats.ranAt || "–") + " v" + SCRIPT_VERSION + "\n" +
      "desktop overlay  : " + (overlayReady ? "已加载（内嵌桌面 overlay.js）" : "尚未激活") + "\n" +
      "mobile state     : " + pendingFrame.mobile.state + "\n" +
      "ws(all) created  : " + stats.wsAll + (stats.lastWsUrl ? "\nlast ws url      : " + stats.lastWsUrl : "") + "\n" +
      "workers          : " + stats.workers + " (shared " + stats.sharedWorkers + ")" +
      (stats.lastWorkerUrl ? "\nlast worker url  : " + stats.lastWorkerUrl : "") + "\n" +
      (stats.reloadHint || "");
  }
  function heartbeat() {
    if (!active || disposed) return;
    lateAttachRelays();
    fragSweep(Date.now());
    ensureDebug();
    if (!overlayReady) deliverFrame();
    var prefSnapshot = JSON.stringify(readOverlayPrefs());
    relayStates.forEach(function (state, ws) {
      if (state.sentPrefs !== prefSnapshot) sendConfig(0, ws);
      else if (state.sent > state.ack && Date.now() - state.sentAt > 30000) sendConfig(state.sent, ws);
    });
    renderDebug();
  }
  function onDomReady() {
    if (!active || disposed) return;
    ensureDebug();
    /* document-start 时无根节点则在 DOM 就绪时补激活，不换一份 UI。 */
    if (!overlayReady) deliverFrame();
  }
  function showManualRefreshHint() {
    hintTimer = 0;
    if (!active || disposed || relaySockets.length) return;
    stats.reloadHint = "尚未捕获中继连接，请手动刷新页面以捕获连接；脚本不会自动刷新。";
    try { console.info("zusage：" + stats.reloadHint); } catch (e) {}
    renderDebug();
  }
  function start() {
    if (disposed || active) return;
    active = true;
    installHooks();
    lateAttachRelays();
    deliverFrame();
    ensureDebug();
    document.addEventListener("DOMContentLoaded", onDomReady);
    heartbeatTimer = setInterval(heartbeat, 2000);
    hintTimer = setTimeout(showManualRefreshHint, 8000);
    heartbeatTimer.unref?.(); hintTimer.unref?.();
  }
  function suspend() {
    if (!active) return;
    active = false;
    clearInterval(heartbeatTimer); clearTimeout(hintTimer);
    heartbeatTimer = 0; hintTimer = 0;
    document.removeEventListener("DOMContentLoaded", onDomReady);
    relaySockets.slice().forEach(function (ws) { removeRelay(ws, true); });
    relayStates.clear(); fragMap.clear();
    activeSource = null; pendingFrame = emptyFrame("waiting");
    removeHooks(); stopDesktopOverlay();
    [dbg, toggle, debugStyle].forEach(function (node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    dbg = null; toggle = null; debugStyle = null;
    if (window.__zusageMobileMode === true) {
      if (previousMobileMode === undefined) delete window.__zusageMobileMode;
      else window.__zusageMobileMode = previousMobileMode;
    }
  }
  function onPageHide() { suspend(); }
  function onPageShow(event) { if (event.persisted) start(); }
  function dispose() {
    if (disposed) return;
    suspend(); disposed = true;
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    if (window.__zmDispose === dispose) delete window.__zmDispose;
  }
  window.__zmDispose = dispose;
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  start();
})();
