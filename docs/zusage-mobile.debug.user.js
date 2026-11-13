// ==UserScript==
// @name         ZCode 用量状态条（远控中继接收端·调试版）
// @namespace    zusage-mobile
// @version      0.6.0
// @description  调试版：默认显示排障面板（帧统计/overlay 加载状态）；日常使用请安装正式版 zusage-mobile.user.js
// @match        https://zcode.z.ai/remote/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/* 配套：zcode-token-usage-statusbar 桌面插件 mobile-relay 功能（specs/mobile-relay.md）。
 * 协议：官方中继 ws2 的 rpc-frame 信封内是 @zcode/rpc 二进制（[1B tag][VQL len][data]）。
 * 本脚本监听 WebSocket message，重组单分片帧，识别 EventFire(204)+魔数 id 的插件帧。
 * 官方页面 ChannelClient 对未知 id 静默丢弃，本脚本零干扰。
 *
 * 本文件是构建产物，不要直接改 docs/zusage-mobile.user.js：源码分片在 src/mobile/，
 * 回退条中「照抄桌面」的内容（格图标/格样式/TPS 色档/显示项行）由
 * scripts/build_mobile_userscript.py 从桌面 src/overlay/ 分片按锚点注释提取注入
 * （specs/mobile-userscript-build.md），桌面更新后重新构建即自动同步。 */
(function () {
  "use strict";

  var MAGIC_ID = 2147483647; // 与桌面 mobile-relay.cjs 约定；官方客户端 id 从 0 递增不会碰撞
  /* 版本只从 @version 元数据取：调试面板曾写死 "v0.1.3"，看板版本永远显示 0.1.3，
   * 被误读成"脚本没更新"。 */
  var SCRIPT_VERSION = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "?";
  /* 调试变体开关（构建注入 __ZM_DEBUG__）：正式版 false——不创建 zm-dbg 面板与 ☰ 钮，
   * 页面零调试痕迹；调试版 true 默认显示排障面板。stats 帧统计两版都照常收集。 */
  var DEBUG_BUILD = true;
  var RELAY_URL_HINT = "/api/v1/remote/ws2";
  var STORAGE_KEY = "zusageMobilePrefs";
  var prefs = { debug: DEBUG_BUILD, lang: "zh", theme: "inline", just: "between", show: {} };
  try { var s = localStorage.getItem(STORAGE_KEY); if (s) prefs = Object.assign(prefs, JSON.parse(s)); } catch (e) {}
  function savePrefs() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (e) {} }

  // ── RPC 二进制解码（@zcode/rpc serialization.ts 的 JS 移植，只读方向）──
  // tag: 0=undef 1=string 2=Buffer 3=VSBuffer 4=array 5=object(JSON) 6=int
  function Reader(bytes) {
    this.b = bytes; this.i = 0;
  }
  Reader.prototype.read = function (n) {
    if (this.i + n > this.b.length) throw new Error("rpc read overrun");
    var out = this.b.subarray(this.i, this.i + n); this.i += n; return out;
  };
  Reader.prototype.readVQL = function () {
    var v = 0;
    for (var shift = 0; ; shift += 7) {
      if (shift > 31) throw new Error("rpc vql overflow");
      var byte = this.read(1)[0];
      v |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return v >>> 0;
    }
  };
  Reader.prototype.deserialize = function () {
    var tag = this.read(1)[0];
    switch (tag) {
      case 0: return undefined;
      case 1: case 2: case 3: { var n = this.readVQL(); var raw = this.read(n); return tag === 1 ? utf8Decode(raw) : raw; }
      case 4: { var len = this.readVQL(); var arr = []; for (var k = 0; k < len; k++) arr.push(this.deserialize()); return arr; }
      case 5: { var bl = this.readVQL(); return JSON.parse(utf8Decode(this.read(bl))); }
      case 6: return this.readVQL();
      default: throw new Error("rpc unknown tag " + tag);
    }
  };
  function utf8Decode(bytes) {
    // 手写 UTF-8，避免 TextDecoder 兼容差异
    var s = "", i = 0;
    while (i < bytes.length) {
      var c = bytes[i];
      if (c < 0x80) { s += String.fromCharCode(c); i += 1; }
      else if (c < 0xe0) { s += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
      else if (c < 0xf0) { s += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
      else {
        var cp = ((c & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        i += 4;
      }
    }
    return s;
  }
  function base64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── 帧统计与解码 ──
  var stats = { wsOpened: 0, relayFrames: 0, decoded: 0, magicFrames: 0, errors: 0, lastError: "", lastTs: 0,
    wsAll: 0, lastWsUrl: "", workers: 0, sharedWorkers: 0, lastWorkerUrl: "", ranAt: "" };

  var lastChips = null;
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
  ".zm-root .it{display:flex;align-items:center;gap:5px;padding:2px 7px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;line-height:inherit;text-align:left;white-space:nowrap;transition:background-color .12s ease-out,color .12s ease-out}.zm-root .it:hover,.zm-root .it:focus-visible{background:var(--color-hover,rgba(255,255,255,.06))}.zm-root .sep{width:1px;height:15px;background:var(--color-border,rgba(255,255,255,.09));flex:0 0 auto;margin:0 3px}.zm-root .k{color:var(--color-foreground-subtle,#a1a1a1)}.zm-root .v{color:var(--color-foreground,#e9edf4);font-weight:600}.zm-root .dim{color:var(--color-foreground-subtle,#a1a1a1);font-weight:400}.zm-root .it{line-height:1.3}.zm-root .it>span:not(.eb):not(.zu-live){display:inline-flex;align-items:center;min-height:1.3em}.zm-root .eb{background:rgba(255,107,87,.14);background:color-mix(in srgb,var(--color-destructive,#ff6b57) 14%,transparent);color:var(--color-destructive,#ff8a73);border-radius:999px;padding:0 6px;line-height:16px;font-weight:600;display:inline-flex;align-items:center;gap:2px}" +
  ".zm-root .zm-band-ok{color:#3ecf8e}.zm-root .zm-tone-ok{color:#3ecf8e}.zm-root .zm-band-warm{color:#f5b944}.zm-root .zm-tone-warm{color:#f5b944}.zm-root .zm-band-hot{color:#ff6b57}.zm-root .zm-tone-hot{color:#ff6b57}.zm-root .zm-band-zu-teal{color:#2dd4bf}.zm-root .zm-tone-zu-teal{color:#2dd4bf}.zm-root .zm-band-zu-sky{color:#38bdf8}.zm-root .zm-tone-zu-sky{color:#38bdf8}.zm-root .zm-band-zu-azure{color:#6d9fff}.zm-root .zm-tone-zu-azure{color:#6d9fff}.zm-root .zm-band-zu-violet{color:#9b8cff}.zm-root .zm-tone-zu-violet{color:#9b8cff}.zm-root .zm-band-zu-purple{color:#bb86fc}.zm-root .zm-tone-zu-purple{color:#bb86fc}.zm-root .zm-band-zu-magenta{color:#d88cff}.zm-root .zm-tone-zu-magenta{color:#d88cff}.zm-root .zm-band-zu-ultra{color:#a78bfa}.zm-root .zm-tone-zu-ultra{color:#a78bfa}.zm-light .zm-band-ok{color:#0f9d6c}.zm-light .zm-tone-ok{color:#0f9d6c}.zm-light .zm-band-warm{color:#b6791a}.zm-light .zm-tone-warm{color:#b6791a}.zm-light .zm-band-hot{color:#d8482f}.zm-light .zm-tone-hot{color:#d8482f}.zm-light .zm-band-zu-teal{color:#087d74}.zm-light .zm-tone-zu-teal{color:#087d74}.zm-light .zm-band-zu-sky{color:#0875a8}.zm-light .zm-tone-zu-sky{color:#0875a8}.zm-light .zm-band-zu-azure{color:#405fd0}.zm-light .zm-tone-zu-azure{color:#405fd0}.zm-light .zm-band-zu-violet{color:#6249c6}.zm-light .zm-tone-zu-violet{color:#6249c6}.zm-light .zm-band-zu-purple{color:#8042bd}.zm-light .zm-tone-zu-purple{color:#8042bd}.zm-light .zm-band-zu-magenta{color:#9638a8}.zm-light .zm-tone-zu-magenta{color:#9638a8}.zm-light .zm-band-zu-ultra{color:#6746d2}.zm-light .zm-tone-zu-ultra{color:#6746d2}" +
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
  var SHOW_ROWS = '<label><input type="checkbox" data-k="turn"><span>本轮<em>tokens、请求次数、耗时与首字延迟</em></span></label>' +
    '<label><input type="checkbox" data-k="win"><span>会话累计<em>当前会话的 tokens、轮数与请求次数</em></span></label>' +
    '<label><input type="checkbox" data-k="proj"><span>项目累计<em>本项目所有会话的消耗（含子代理），按目录归属</em></span></label>' +
    '<label><input type="checkbox" data-k="today"><span>今日合计<em>今天所有会话的消耗</em></span></label>' +
    '<label><input type="checkbox" data-k="tools"><span>工具调用<em>悬停查看各工具明细与错误</em></span></label>' +
    '<label><input type="checkbox" data-k="sub"><span>子代理<em>悬停或点击状态条上的子代理查看统计</em></span></label>';
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
  var ICONS = {speed: '<path d="M13.5 2 3.5 13.5H11L10 22l10.5-12H13l.5-8z"/>', turn: '<path d="M5 3.5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9l-6.5 4V5.5a2 2 0 0 1 1.5-2z"/><path d="M7.5 8.5h9m-9 4h6"/>', win: '<path d="M7.5 3h12a2 2 0 0 1 2 2v10M4.5 7h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-5.5 2V9a2 2 0 0 1 2-2z"/>', today: '<rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M7.5 2.5v4m9-4v4M3 10h18m-13.5 4h2m5 0h2m-9 4h2m5 0h2"/>', proj: '<path d="M3.5 6.5a2 2 0 0 1 2-2h4.2l2 2h7.3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>', tools: '<path d="M14.5 2.5a6 6 0 0 0-5.6 8.1L3.3 16.2a3.2 3.2 0 0 0 4.5 4.5l5.6-5.6a6 6 0 0 0 8.1-5.6l-4.1 3-3.8-3.8 3-4.1a6 6 0 0 0-2.1-2.1z"/>', sub: '<circle cx="5" cy="5" r="3"/><circle cx="19" cy="8" r="3"/><circle cx="5" cy="19" r="3"/><path d="M5 8v8m0-4h9a5 5 0 0 0 5-1"/>'};
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
