  /* 分片重组：快照帧（>单帧物理上限）会被宿主 AcknowledgedRelayProtocol 拆成多个
   * rpc-frame（fragmentIndex/Count，dataBase64=分片字节），桌面 ChannelClient 重组后
   * 才进 handlers——本脚本在 WS 层旁听，必须自己重组。键=bridgeSessionId+seq；
   * >60s 未完成的残片丢弃，防泄漏。 */
  var fragMap = new Map();
  function fragSweep(now) {
    fragMap.forEach(function (e, k) { if (now - e.t > 60000) fragMap.delete(k); });
  }
  function handleFrameBytes(bytes) {
    try {
      var r = new Reader(bytes);
      var header = r.deserialize();
      if (!Array.isArray(header) || header[0] !== 204) return; // 只关心 EventFire
      stats.decoded++;
      if (header[1] !== MAGIC_ID) return;
      var body = r.deserialize();
      if (!body || typeof body !== "object" || body.zm !== 1) return; // zm 标记二次校验
      stats.magicFrames++;
      stats.lastTs = Date.now();
      lastChips = body;
      /* 能力握手：公告帧（无 snap，仅 zuUpCap/cfgGen）与快照帧都可能携带，
       * 在这里统一记账——公告帧是握手起点（桌面等配置、手机等能力，靠它打破死锁）。 */
      if (typeof body.zuUpCap === "number" || typeof body.cfgGen === "number") noteDownlink(body);
      if (body.snap) applySnap(body);   // 整份快照喂给桌面 overlay 渲染
      render();
    } catch (e) {
      stats.errors++; stats.lastError = e.message;
      renderDebug();
    }
  }
  function handleWsMessage(ev) {
    if (typeof ev.data !== "string") return;
    var env;
    try { env = JSON.parse(ev.data); } catch (e) { return; }
    var p = env && env.type === "data" && env.payload;
    if (!p || p.zcode_type !== "rpc-frame") return;
    stats.relayFrames++;
    var now = Date.now();
    if (fragMap.size && (fragMap.size % 32 === 0)) fragSweep(now);
    /* 多分片：收集齐后拼接重组 */
    if ((p.fragmentCount | 0) > 1) {
      var key = (p.bridgeSessionId || "") + ":" + (p.messageSeq !== undefined ? p.messageSeq : p.seq);
      var e2 = fragMap.get(key);
      if (!e2) { e2 = { n: p.fragmentCount | 0, parts: new Array(p.fragmentCount | 0), t: now }; fragMap.set(key, e2); }
      var idx = p.fragmentIndex | 0;
      if (!e2.parts[idx] && typeof p.dataBase64 === "string" && p.dataBase64) {
        try { e2.parts[idx] = base64ToBytes(p.dataBase64); } catch (e3) { fragMap.delete(key); return; }
      }
      var got = 0, total = 0;
      for (var q = 0; q < e2.parts.length; q++) { if (e2.parts[q]) { got++; total += e2.parts[q].length; } }
      if (got >= e2.n) {
        fragMap.delete(key);
        var all = new Uint8Array(total), off = 0;
        for (var w = 0; w < e2.parts.length; w++) { all.set(e2.parts[w], off); off += e2.parts[w].length; }
        handleFrameBytes(all);
      }
      return;
    }
    if (p.fragmentCount !== 1 || p.fragmentIndex !== 0) return;
    if (typeof p.dataBase64 !== "string" || !p.dataBase64) return;
    var bytes;
    try { bytes = base64ToBytes(p.dataBase64); } catch (e) { stats.errors++; stats.lastError = "b64: " + e.message; return; }
    handleFrameBytes(bytes);
  }

  /* ── 桌面 overlay 复用（0.4.0「全照抄」的最终形态）──
   * 手机端不再自渲染，直接加载桌面插件**同一份 overlay.js**（CDN @main，失败回落
   * raw.githubusercontent），把中继帧里的 zusage 快照喂给它的 window.__zusageUpdate。
   * 样式/图标/设置面板（完整 ⚙）/tooltip/浅色主题/偏好键（zusage3.*）全部与桌面逐字节
   * 同源，桌面插件更新后手机端下次加载自动跟上。mine = 中继帧 target.taskId，
   * overlay 的会话绑定走同一逻辑。overlay 加载失败（离线/CDN 不可达）回落旧 chips 条。 */
  var OVERLAY_URLS = [
    "https://cdn.jsdelivr.net/gh/ByteRax/zcode-token-usage-statusbar@main/overlay.js",
    "https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/overlay.js",
  ];
  var overlayReady = false, overlayLoading = false, pendingSnap = null;
  /* 上行记账：lastCapAt = 最近一次见到 zuUpCap 的时间（能力窗口）；sentCfgGen/lastCfgAckGen
   * 驱动 30s 幂等重试。relaySockets 是已捕获的 relay WS（30 分片登记）。 */
  var lastCapAt = 0, sentCfgGen = 0, lastCfgAckGen = 0, lastCfgSendAt = 0;
  var relaySockets = [];
  /* 配置载荷 = 手机端 overlay 的显示偏好（zusage3.* 同键，本地 storage 只读写自己的浏览器）：
   * 桌面按 show 裁剪推送内容；theme/just/lang 供桌面侧对齐语义。不含任何敏感键。 */
  function readOverlayPrefs() {
    function g(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
    return {
      show: g("zusage3.show", "{}"),
      theme: g("zusage3.theme", "default"),
      just: g("zusage3.barJust", "between"),
      lang: g("zusage3.lang", "zh"),
      cnNum: g("zusage3.cnNum", "1"),
      forceKmb: g("zusage3.forceKmb", "0"),
    };
  }
  function noteDownlink(body) {
    if (typeof body.zuUpCap === "number" && body.zuUpCap >= 2) {
      var firstCap = !lastCapAt;
      lastCapAt = Date.now();
      if (firstCap) {
        lastCfgAckGen = Math.max(lastCfgAckGen, typeof body.cfgGen === "number" ? body.cfgGen : 0);
        sendConfig(lastCfgAckGen + 1);
      }
    }
    if (typeof body.cfgGen === "number" && body.cfgGen > lastCfgAckGen) {
      lastCfgAckGen = body.cfgGen;
      renderDebug();
    }
  }
  /* 上行发送：仅当最近 45s 见过 zuUpCap（无补丁宿主收到 rpc 形态帧会撞严格 seq 校验
   * → messageGap terminal 打挂会话，这道门不可省）。gen 显式传入；0 = 自动新 gen。 */
  function sendConfig(gen) {
    if (Date.now() - lastCapAt > 45000) return false;
    if (!gen || gen <= 0) gen = Math.max(sentCfgGen, lastCfgAckGen) + 1;
    var frame = JSON.stringify({ type: "data", payload: {
      zcode_type: "rpc-frame", zuUp: 2, bridgeSessionId: "zusage-uplink",
      zuCfg: { gen: gen, prefs: readOverlayPrefs() },
    } });
    var sent = 0;
    for (var i = relaySockets.length - 1; i >= 0; i--) {
      var ws = relaySockets[i];
      try {
        if (ws.readyState === 1) { ws.send(frame); sent++; }
        else relaySockets.splice(i, 1);
      } catch (e) { relaySockets.splice(i, 1); }
    }
    if (sent) { sentCfgGen = Math.max(sentCfgGen, gen); lastCfgSendAt = Date.now(); renderDebug(); }
    return sent > 0;
  }
  /* 晚注入补挂（CDP 调试用）：__zmWSList 里未挂监听的 relay WS 补挂。 */
  function lateAttachRelays() {
    var list;
    try { list = window.__zmWSList; } catch (e) { return; }
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i++) {
      var ws = list[i];
      if (!ws || ws.__zmAttached) continue;
      try {
        ws.__zmAttached = true;
        ws.addEventListener("close", function () {
          var j = list.indexOf(ws); if (j >= 0) list.splice(j, 1);
          var k = relaySockets.indexOf(ws); if (k >= 0) relaySockets.splice(k, 1);
        });
        ws.addEventListener("message", handleWsMessage);
        relaySockets.push(ws);
        stats.wsOpened++;
      } catch (e) { }
    }
  }
  /* 快照帧 → 桌面 overlay：mine 绑定目标会话，喂 __zusageUpdate 后隐藏旧 chips 条。 */
  function applySnap(body) {
    if (!body || !body.snap) return;
    noteDownlink(body);
    if (!overlayReady) { pendingSnap = body; loadOverlay(); return; }
    try {
      var d = body.snap;
      d.mine = (body.target && body.target.taskId) || body.mine || "";
      window.__zusageUpdate(d);
      if (root) root.style.display = "none";   // 桌面条已挂载，隐藏旧 chips 条避免双条
      if (dbg) dbg.style.display = prefs.debug ? "block" : "none";
    } catch (e) {
      stats.errors++; stats.lastError = "snap: " + e.message;
    }
  }
  function loadOverlay() {
    if (overlayReady || overlayLoading) return;
    overlayLoading = true;
    (function tryNext(i) {
      if (i >= OVERLAY_URLS.length) { overlayLoading = false; renderDebug(); render(); return; }   // 全失败：回落旧 chips 条
      fetch(OVERLAY_URLS[i], { cache: "no-cache" })
        .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error("http " + r.status)); })
        .then(function (code) {
          var sc = document.createElement("script");
          sc.textContent = code;
          document.head.appendChild(sc);   // 自包含 IIFE，追加即执行
          if (!(window.__zusageOverlay && typeof window.__zusageUpdate === "function")) throw new Error("overlay not active");
          overlayReady = true;
          stats.overlayReady = true;
          renderDebug();
          if (pendingSnap) { var b = pendingSnap; pendingSnap = null; applySnap(b); }
          render();
        })
        .catch(function (e) { try { stats.lastError = "overlay[" + i + "]: " + e.message; } catch (e2) {} tryNext(i + 1); });
  })(0);
  }
