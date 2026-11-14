(function () {
  "use strict";

  var MAGIC_ID = 2147483647; // 与桌面 mobile-relay.cjs 约定；官方客户端 id 从 0 递增不会碰撞
  /* 版本只从 @version 元数据取：调试面板曾写死 "v0.1.3"，看板版本永远显示 0.1.3，
   * 被误读成"脚本没更新"。 */
  var SCRIPT_VERSION = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "?";
  /* 调试变体开关（构建注入 __ZM_DEBUG__）：正式版 false——不创建 zm-dbg 面板与 ☰ 钮，
   * 页面零调试痕迹；调试版 true 默认显示排障面板。stats 帧统计两版都照常收集。 */
  var DEBUG_BUILD = __ZM_DEBUG__;
  /* 前代负责撤除自己的消费者；宿主连接保留给本代补挂。 */
  try { if (typeof window.__zmDispose === "function") window.__zmDispose(); } catch (e) {}
  var disposed = false, active = false;
  var RELAY_URL_HINT = "/api/v1/remote/ws2";
  var STORAGE_KEY = "zusageMobilePrefs";
  var prefs = { debug: DEBUG_BUILD };
  var legacy = null;
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) legacy = JSON.parse(saved);
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy) && typeof legacy.debug === "boolean")
      prefs.debug = legacy.debug;
  } catch (e) {}
  function savePrefs() {
    try {
      var old = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (old && typeof old === "object" && !Array.isArray(old)) {
        old.debug = prefs.debug;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(old));
      }
    } catch (e) {}
  }
  /* 旧回退偏好只在桌面同名键缺失时迁移，已有桌面设置始终优先。 */
  try {
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      if (legacy.show && typeof legacy.show === "object" && !Array.isArray(legacy.show) && localStorage.getItem("zusage3.show") === null)
        localStorage.setItem("zusage3.show", JSON.stringify(legacy.show));
      if ((legacy.theme === "inline" || legacy.theme === "pill") && localStorage.getItem("zusage3.theme") === null)
        localStorage.setItem("zusage3.theme", legacy.theme === "pill" ? "pill" : "default");
      if (["between", "start", "end"].indexOf(legacy.just) >= 0 && localStorage.getItem("zusage3.barJust") === null)
        localStorage.setItem("zusage3.barJust", legacy.just);
      if ((legacy.lang === "zh" || legacy.lang === "en") && localStorage.getItem("zusage3.lang") === null)
        localStorage.setItem("zusage3.lang", legacy.lang);
    }
  } catch (e) {}

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

  var previousMobileMode = window.__zusageMobileMode;
