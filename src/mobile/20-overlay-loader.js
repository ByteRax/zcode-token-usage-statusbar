  /* 分片、顺序与能力均属于同一 socket，不跨连接拼接或继承。 */
  var fragMap = new Map();
  var relaySockets = [], relayStates = new Map();
  var overlayReady = false, overlayDispose = null;
  var activeSource = null, activeSourceEpoch = 0, nextSourceEpoch = 0;
  var readyUntil = 0, DATA_TTL_MS = 30000;
  var pendingFrame = emptyFrame("waiting");
  var OVERLAY_CODE = __ZM_OVERLAY_SOURCE__;

  function emptyFrame(state, body) {
    var target = body && body.target && body.target.taskId || "";
    return { session: {}, recent: [], mine: validId(target) ? target : "", mobile: {
      taskId: validId(target) ? target : "", binding: body && validBinding(body.binding) ? body.binding : "",
      scopeKind: body && (body.scopeKind === "local" || body.scopeKind === "remote") ? body.scopeKind : "", state: state,
    } };
  }
  function fragSweep(now) {
    fragMap.forEach(function (parts, ws) {
      parts.forEach(function (entry, key) { if (now - entry.t > 60000) parts.delete(key); });
      if (!parts.size) fragMap.delete(ws);
    });
    /* 沿用既有 heartbeat，不额外注册计时器；公告与无效帧均不能续数据寿命。 */
    if (expireReady(now) && active && !disposed) deliverFrame();
  }
  function expireReady(now) {
    if (pendingFrame.mobile.state !== "ready" || !readyUntil || now <= readyUntil) return false;
    var mobile = pendingFrame.mobile;
    pendingFrame = emptyFrame("unavailable", { target: { taskId: mobile.taskId },
      binding: mobile.binding, scopeKind: mobile.scopeKind });
    readyUntil = 0;
    return true;
  }
  function record(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
  function validId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
  function validBinding(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
  /* wire 不得包含真实工作区身份或远端目标；空兼容字段不构成身份。深度超限拒绝。 */
  function hasPrivateIdentity(value, depth) {
    if (!value || typeof value !== "object") return false;
    if (depth > 32) return true;
    return Object.keys(value).some(function (key) {
      if ((key === "workspace_identity" || key === "workspaceIdentity" || key === "remote_target" || key === "remoteTarget") &&
          value[key] !== undefined && value[key] !== null && value[key] !== "") return true;
      return hasPrivateIdentity(value[key], depth + 1);
    });
  }
  function validTarget(body) {
    return record(body.target) && validId(body.target.taskId) && body.mine === body.target.taskId &&
      validBinding(body.binding) && (body.scopeKind === "local" || body.scopeKind === "remote");
  }
  function frameKind(body) {
    if (hasPrivateIdentity(body, 0)) return "";
    if (body.state === "unavailable") {
      return validTarget(body) && body.snap === undefined && body.chips === undefined && body.bySession === undefined ? "unavailable" : "";
    }
    if (body.state !== undefined && body.state !== "ready") return "";
    /* 旧版只有 chips；不从格式化字符串倒推假统计。 */
    if (body.snap === undefined && (Array.isArray(body.chips) || record(body.bySession))) {
      if (body.target !== undefined && (!record(body.target) || !validId(body.target.taskId) ||
          (body.mine !== undefined && body.mine !== body.target.taskId))) return "";
      if (body.scopeKind !== undefined && body.scopeKind !== "local" && body.scopeKind !== "remote") return "";
      return "upgrade";
    }
    if (!validTarget(body) || !record(body.snap)) return "";
    var snap = body.snap, target = body.target.taskId;
    if (!record(snap.session) || snap.session.sid !== target || !Array.isArray(snap.recent) || snap.recent.length !== 1 ||
        !record(snap.recent[0]) || snap.recent[0].sid !== target || (snap.mine !== undefined && snap.mine !== target)) return "";
    if (body.scopeKind === "remote") {
      if (snap.session.remote !== true || snap.recent[0].remote !== true) return "";
    } else if (snap.remote || snap.session.remote || snap.recent[0].remote) return "";
    return "ready";
  }
  function handleFrameBytes(bytes, ws, order) {
    if (!active || disposed) return;
    try {
      var reader = new Reader(bytes), header = reader.deserialize();
      if (!Array.isArray(header) || header[0] !== 204) return;
      stats.decoded++;
      if (header[1] !== MAGIC_ID) return;
      var body = reader.deserialize();
      if (!record(body) || body.zm !== 1) return;
      stats.magicFrames++;
      /* 公告不推进数据水位，也不刷新有效数据时间。 */
      if (typeof body.zuUpCap === "number" || typeof body.cfgGen === "number") noteDownlink(body, ws);
      var kind = frameKind(body), now = Date.now();
      if (!kind || (kind === "ready" && (!Number.isFinite(body.ts) || body.ts <= 0 || now - body.ts > DATA_TTL_MS)) ||
          !acceptDataOrder(ws, order)) return;
      stats.lastTs = now;
      readyUntil = kind === "ready" ? Math.min(now, body.ts) + DATA_TTL_MS : 0;
      if (kind === "ready") {
        pendingFrame = Object.assign({}, body.snap, { mine: body.target.taskId, mobile: {
          taskId: body.target.taskId, binding: body.binding, scopeKind: body.scopeKind, state: body.state || "ready",
        } });
      } else pendingFrame = emptyFrame(kind, body);
      deliverFrame();
      renderDebug();
    } catch (e) {
      stats.errors++; stats.lastError = "frame: " + e.message;
      renderDebug();
    }
  }
  function handleWsMessage(ev) {
    if (!active || disposed || typeof ev.data !== "string") return;
    var env;
    try { env = JSON.parse(ev.data); } catch (e) { return; }
    var payload = env && env.type === "data" && env.payload;
    if (!payload || payload.zcode_type !== "rpc-frame") return;
    var ws = ev.currentTarget || ev.target;
    if (!relayStates.has(ws)) return;
    stats.relayFrames++;
    var now = Date.now();
    if (fragMap.size) fragSweep(now);
    var order = { bridge: typeof payload.bridgeSessionId === "string" ? payload.bridgeSessionId : "",
      seq: Number.isSafeInteger(payload.messageSeq) && payload.messageSeq >= 0 ? payload.messageSeq :
        (Number.isSafeInteger(payload.seq) && payload.seq >= 0 ? payload.seq : null) };
    var state = relayStates.get(ws);
    /* 已被有效数据替代的连接或桥不再积累残片；纯公告从不推进这些水位。 */
    if (state.sourceEpoch < activeSourceEpoch || state.retiredBridges.has(order.bridge)) return;
    var count = payload.fragmentCount, index = payload.fragmentIndex;
    if (!Number.isInteger(count) || count < 1 || count > 256 || !Number.isInteger(index) || index < 0 || index >= count ||
        typeof payload.dataBase64 !== "string" || !payload.dataBase64) return;
    if (count > 1) {
      if (order.seq === null) return;
      var key = order.bridge + ":" + order.seq;
      var parts = fragMap.get(ws);
      if (!parts) { parts = new Map(); fragMap.set(ws, parts); }
      var entry = parts.get(key);
      if (!entry) { entry = { n: count, parts: new Array(count), t: now }; parts.set(key, entry); }
      if (entry.n !== count) return;
      if (!entry.parts[index]) {
        try { entry.parts[index] = base64ToBytes(payload.dataBase64); } catch (e) { parts.delete(key); return; }
      }
      var got = 0, total = 0;
      for (var q = 0; q < entry.parts.length; q++) {
        if (entry.parts[q]) { got++; total += entry.parts[q].length; }
      }
      if (total > 4 * 1024 * 1024) { parts.delete(key); return; }
      if (got === count) {
        parts.delete(key);
        if (!parts.size) fragMap.delete(ws);
        var all = new Uint8Array(total), off = 0;
        for (var i = 0; i < entry.parts.length; i++) { all.set(entry.parts[i], off); off += entry.parts[i].length; }
        handleFrameBytes(all, ws, order);
      }
      return;
    }
    try { handleFrameBytes(base64ToBytes(payload.dataBase64), ws, order); }
    catch (e) { stats.errors++; stats.lastError = "base64 decode failed"; renderDebug(); }
  }
  function acceptDataOrder(ws, order) {
    var state = relayStates.get(ws);
    if (!state || state.sourceEpoch < activeSourceEpoch || state.retiredBridges.has(order.bridge)) return false;
    var previous = state.dataSeq.get(order.bridge);
    if (order.seq === null ? previous !== undefined : previous !== undefined && order.seq <= previous) return false;
    /* 只有完整、有效且新鲜的数据能切换桥，seq 从新桥自己的起点重新计。 */
    if (state.currentBridge !== order.bridge) {
      if (state.currentBridge !== null) state.retiredBridges.add(state.currentBridge);
      state.currentBridge = order.bridge;
      state.dataSeq.clear();
      fragMap.delete(ws);
    }
    if (state.sourceEpoch > activeSourceEpoch) {
      activeSourceEpoch = state.sourceEpoch;
      relayStates.forEach(function (other, socket) {
        if (other.sourceEpoch < activeSourceEpoch) fragMap.delete(socket);
      });
    }
    activeSource = ws;
    if (order.seq !== null) state.dataSeq.set(order.bridge, order.seq);
    return true;
  }

  /* 唯一 UI 的源码随油猴脚本构建固定；激活前显式启用远控快照上下文。 */
  function loadOverlay() {
    if (overlayReady || !active || disposed || !document.body) return;
    var host = document.head || document.documentElement;
    if (!host) return;
    var script = document.createElement("script");
    try {
      window.__zusageMobileMode = true;
      /* 远控页面只读取统计；即使页面残留桌面状态，也不授予配置推送的能力。 */
      window.__zusagePluginState = Object.assign({}, window.__zusagePluginState, {
        mobileRelayEnabled: false, mobileRelaySupported: false,
      });
      script.textContent = OVERLAY_CODE;
      host.appendChild(script);
      if (!(window.__zusageOverlay && typeof window.__zusageUpdate === "function")) throw new Error("overlay not active");
      overlayReady = true;
      overlayDispose = window.__zusageDispose;
    } catch (e) {
      stats.errors++; stats.lastError = "overlay: " + e.message;
    } finally {
      if (script.parentNode) script.parentNode.removeChild(script);
    }
  }
  function deliverFrame() {
    expireReady(Date.now());
    loadOverlay();
    if (!overlayReady) return;
    try { window.__zusageUpdate(pendingFrame); }
    catch (e) { stats.errors++; stats.lastError = "overlay update: " + e.message; }
  }
  function stopDesktopOverlay() {
    if (overlayReady && window.__zusageDispose === overlayDispose && typeof overlayDispose === "function") {
      try { overlayDispose(); } catch (e) {}
    }
    overlayReady = false;
    overlayDispose = null;
  }
  function readOverlayPrefs() {
    function get(key, fallback) { try { var value = localStorage.getItem(key); return value === null ? fallback : value; } catch (e) { return fallback; } }
    return { show: get("zusage3.show", "{}"), theme: get("zusage3.theme", "default"), just: get("zusage3.barJust", "between"),
      lang: get("zusage3.lang", "zh"), cnNum: get("zusage3.cnNum", "1"), forceKmb: get("zusage3.forceKmb", "0") };
  }
  function noteDownlink(body, ws) {
    var state = relayStates.get(ws);
    if (!state) return;
    var serverGen = Number.isSafeInteger(body.cfgGen) && body.cfgGen >= 0 ? body.cfgGen : null;
    if (typeof body.zuUpCap === "number" && isFinite(body.zuUpCap) && body.zuUpCap >= 2) {
      var firstCap = !state.capAt || Date.now() - state.capAt > 45000;
      state.capAt = Date.now();
      if (firstCap) {
        if (serverGen !== null) state.ack = serverGen;
        sendConfig(0, ws);
        return;
      }
    }
    if (!state.capAt || serverGen === null) return;
    if (serverGen < state.ack) {
      state.ack = serverGen;
      sendConfig(0, ws);
    } else if (serverGen > state.ack) { state.ack = serverGen; renderDebug(); }
  }
  function sendConfig(gen, onlyWs) {
    if (!active || disposed) return false;
    var sent = 0;
    for (var i = relaySockets.length - 1; i >= 0; i--) {
      var ws = relaySockets[i], state = relayStates.get(ws);
      if (onlyWs && ws !== onlyWs) continue;
      if (!state || !state.capAt || Date.now() - state.capAt > 45000) continue;
      var nextGen = gen > 0 ? gen : Math.max(state.sent, state.ack) + 1;
      var currentPrefs = readOverlayPrefs();
      var frame = JSON.stringify({ type: "data", payload: {
        zcode_type: "rpc-frame", zuUp: 2, bridgeSessionId: "zusage-uplink", zuCfg: { gen: nextGen, prefs: currentPrefs },
      } });
      try {
        if (ws.readyState === 1) {
          ws.send(frame); sent++; state.sent = Math.max(state.sent, nextGen); state.sentAt = Date.now();
          state.sentPrefs = JSON.stringify(currentPrefs);
        } else if (ws.readyState > 1) removeRelay(ws);
      } catch (e) { removeRelay(ws); }
    }
    if (sent) renderDebug();
    return sent > 0;
  }
  function attachRelay(ws) {
    if (!active || disposed || !ws || ws.readyState > 1 || relayStates.has(ws)) return;
    var state = { capAt: 0, sent: 0, ack: 0, sentAt: 0, dataSeq: new Map(),
      currentBridge: null, retiredBridges: new Set(), sourceEpoch: ++nextSourceEpoch,
      onClose: function () { removeRelay(ws); } };
    relaySockets.push(ws);
    relayStates.set(ws, state);
    ws.addEventListener("close", state.onClose);
    ws.addEventListener("message", handleWsMessage);
    stats.wsOpened++;
  }
  function removeRelay(ws, preserveSocket) {
    var state = relayStates.get(ws);
    var index = relaySockets.indexOf(ws); if (index >= 0) relaySockets.splice(index, 1);
    relayStates.delete(ws);
    fragMap.delete(ws);
    try {
      ws.removeEventListener("message", handleWsMessage);
      if (state) ws.removeEventListener("close", state.onClose);
      var list = window.__zmWSList;
      if (!preserveSocket && Array.isArray(list)) {
        var position = list.indexOf(ws); if (position >= 0) list.splice(position, 1);
      }
    } catch (e) {}
    if (activeSource === ws) {
      activeSource = null;
      readyUntil = 0;
      pendingFrame = emptyFrame("waiting");
      if (active) deliverFrame();
    }
  }
  function lateAttachRelays() {
    var list = window.__zmWSList;
    if (!Array.isArray(list)) return;
    list.slice().forEach(function (ws) {
      try {
        if (ws && ws.readyState <= 1) attachRelay(ws);
        else removeRelay(ws);
      } catch (e) {}
    });
  }
