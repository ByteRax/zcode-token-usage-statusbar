  // ── WebSocket 劫持（observe-only）；复用前置 hook 的 __zmWSList ──
  var NativeWS = null, PatchedWS = null;
  var NativeWorker = null, PatchedWorker = null, NativeSW = null, PatchedSW = null;
  function safeUrl(value) {
    try {
      var url = new URL(String(value), location.href);
      if (["http:", "https:", "ws:", "wss:"].indexOf(url.protocol) < 0) return "[非网络 URL]";
      return url.protocol + "//" + url.host + url.pathname;
    } catch (e) { return "[URL 不可解析]"; }
  }
  function installHooks() {
    var Constructor = window.WebSocket;
    NativeWS = Constructor;
    PatchedWS = function (url, protocols) {
      var text = "";
      try { text = String(url); } catch (e) {}
      stats.wsAll++;
      stats.lastWsUrl = safeUrl(url);
      var ws = protocols === undefined ? new Constructor(url) : new Constructor(url, protocols);
      try {
        if (text.indexOf(RELAY_URL_HINT) !== -1) {
          var list = window.__zmWSList;
          if (!Array.isArray(list)) list = window.__zmWSList = [];
          if (list.indexOf(ws) < 0) list.push(ws);
          attachRelay(ws);
        }
      } catch (e) {}
      return ws;
    };
    try {
      PatchedWS.prototype = NativeWS.prototype;
      Object.defineProperties(PatchedWS, {
        CONNECTING: { value: NativeWS.CONNECTING }, OPEN: { value: NativeWS.OPEN },
        CLOSING: { value: NativeWS.CLOSING }, CLOSED: { value: NativeWS.CLOSED },
        prototype: { value: NativeWS.prototype, writable: false },
      });
      Object.defineProperty(window, "WebSocket", { value: PatchedWS, writable: true, configurable: true });
    } catch (e) {}
    /* Worker 包装仅用于调试诊断，正式版不额外挂钩。 */
    if (DEBUG_BUILD) {
      try {
        var WorkerConstructor = window.Worker;
        NativeWorker = WorkerConstructor;
        if (typeof NativeWorker === "function") {
          PatchedWorker = function (url, opts) {
            stats.workers++; stats.lastWorkerUrl = safeUrl(url);
            return opts === undefined ? new WorkerConstructor(url) : new WorkerConstructor(url, opts);
          };
          PatchedWorker.prototype = NativeWorker.prototype;
          window.Worker = PatchedWorker;
        }
      } catch (e) {}
      try {
        var SharedConstructor = window.SharedWorker;
        NativeSW = SharedConstructor;
        if (typeof NativeSW === "function") {
          PatchedSW = function (url, opts) {
            stats.sharedWorkers++; stats.lastWorkerUrl = safeUrl(url);
            return opts === undefined ? new SharedConstructor(url) : new SharedConstructor(url, opts);
          };
          PatchedSW.prototype = NativeSW.prototype;
          window.SharedWorker = PatchedSW;
        }
      } catch (e) {}
    }
  }
  function removeHooks() {
    try { if (window.WebSocket === PatchedWS) window.WebSocket = NativeWS; } catch (e) {}
    try { if (PatchedWorker && window.Worker === PatchedWorker) window.Worker = NativeWorker; } catch (e) {}
    try { if (PatchedSW && window.SharedWorker === PatchedSW) window.SharedWorker = NativeSW; } catch (e) {}
  }
  try { stats.ranAt = document.readyState + "@" + new Date().toTimeString().slice(0, 8); } catch (e) {}
