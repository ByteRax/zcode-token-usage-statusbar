  // ── WebSocket 劫持（observe-only）──
  var NativeWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    var u = "";
    try { u = String(url); } catch (e) {}
    stats.wsAll++;
    stats.lastWsUrl = u.slice(0, 160);
    var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    try {
      if (u.indexOf(RELAY_URL_HINT) !== -1) {
        stats.wsOpened++;
        relaySockets.push(ws);   // 上行发送（sendConfig）
        try { (window.__zmWSList = window.__zmWSList || []).push(ws); ws.__zmAttached = true; } catch (e2) { }
        ws.addEventListener("close", function () {
          var i = relaySockets.indexOf(ws);
          if (i >= 0) relaySockets.splice(i, 1);
        });
        ws.addEventListener("message", handleWsMessage);
      }
    } catch (e) {}
    return ws;
  }
  try {
    PatchedWS.prototype = NativeWS.prototype;
    Object.defineProperties(PatchedWS, {
      CONNECTING: { value: NativeWS.CONNECTING }, OPEN: { value: NativeWS.OPEN },
      CLOSING: { value: NativeWS.CLOSING }, CLOSED: { value: NativeWS.CLOSED },
      prototype: { value: NativeWS.prototype, writable: false },
    });
    // 页面可能用 instanceof 检测；prototype 同源保证兼容
    Object.defineProperty(window, "WebSocket", { value: PatchedWS, writable: true, configurable: true });
  } catch (e) {}
  // v0.1.2 诊断：透明包装 Worker/SharedWorker，只计数不改变行为（判断中继连接是否走了 Worker）
  try {
    var NativeWorker = window.Worker;
    if (typeof NativeWorker === "function") {
      window.Worker = function (url, opts) {
        stats.workers++;
        try { stats.lastWorkerUrl = String(url).slice(0, 160); } catch (e) {}
        return opts === undefined ? new NativeWorker(url) : new NativeWorker(url, opts);
      };
      window.Worker.prototype = NativeWorker.prototype;
    }
  } catch (e) {}
  try {
    var NativeSW = window.SharedWorker;
    if (typeof NativeSW === "function") {
      window.SharedWorker = function (url, opts) {
        stats.sharedWorkers++;
        try { stats.lastWorkerUrl = "shared:" + String(url).slice(0, 150); } catch (e) {}
        return opts === undefined ? new NativeSW(url) : new NativeSW(url, opts);
      };
      window.SharedWorker.prototype = NativeSW.prototype;
    }
  } catch (e) {}
  try { stats.ranAt = document.readyState + "@" + new Date().toTimeString().slice(0, 8); } catch (e) {}
