/**
 * zusage web 引导脚本 —— 数据泵（唯一注入入口）。
 *
 * 它负责原 Electron 主进程 `inject-main.cjs` 干的那两件事：
 *   1. 把 payload 送进页面：window.__zusageUpdate(payload)
 *   2. 告诉服务端「本窗口当前是哪个会话」：payload.mine
 *
 * 与桌面版的差异（web 没有文件系统、没有 IPC）：
 *   - 触发：fs.watch 事件 → 轮询（可见 2~4s / 隐藏 20s / visibilitychange 立即）
 *   - 当前会话：IPC 上报 → composer 祖先链的 data-session-id（两端 DOM 一致，见方案 §6.3）
 *   - 凭证：设备会话 Cookie（/login 配对后自动随请求带上，URL 无任何凭据参数）。
 *          v3（2026-10-11）：旧 URL ?token= 与钩 WebSocket 取 wsUrl ?token= 的通道随
 *          单 token 模型退役（3030 已不认 query token）；未配对时快照 401 → 自动退避 30s。
 *
 * 渲染全部交给 overlay.js（一份实现，窄屏/宽屏自适应）。
 */
(function () {
  'use strict';
  if (window.__zusageBoot) return;
  window.__zusageBoot = true;

  var NS = (window.__zusageWeb = window.__zusageWeb || {});
  NS.version = 'web-3';
  NS.lastPayload = null;
  NS.diag = { bootAt: Date.now(), polls: 0, errors: 0, lastError: '', noAuth: false };

  var BASE = '/zusage';
  var OVERLAY = BASE + '/overlay.js';

  /* ---------- 快照请求 ---------- */
  /* 凭证：设备会话 Cookie（credentials:'same-origin' 自动携带），URL 无凭据参数。 */
  function snapshotUrl(sids, sid) {
    var q = '?sids=' + encodeURIComponent(sids.join(',')) + '&mine=' + encodeURIComponent(sid);
    return BASE + '/snapshot' + q;
  }

  /* ---------- 当前会话（与插件同源规则：composer 祖先链的 data-session-id） ---------- */
  function currentSid() {
    var panes;
    try { panes = document.querySelectorAll('[data-session-id]'); } catch (e) { return ''; }
    var fallback = '';
    for (var i = 0; i < panes.length; i++) {
      var el = panes[i], r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 40 || r.height < 40 || r.bottom < 0 || r.top > innerHeight) continue;
      var sid = el.getAttribute('data-session-id') || '';
      if (!sid || sid === 'draft') continue;
      try { if (el.contains(document.activeElement)) return sid; } catch (e) {}
      if (!fallback) fallback = sid;
    }
    return fallback;
  }

  /* ---------- overlay 注入（只注入一次；overlay 自己按视口宽度切换布局） ---------- */
  function injectOverlay() {
    if (document.querySelector('script[data-zusage-overlay]')) return;
    var s = document.createElement('script');
    s.src = OVERLAY;
    s.setAttribute('data-zusage-overlay', '1');
    s.async = false;
    s.onerror = function () { NS.diag.errors++; NS.diag.lastError = 'overlay 载入失败'; };
    document.head.appendChild(s);
  }

  /* ---------- 数据泵 ---------- */
  var timer = null, inflightReq = null;

  function cadence() {
    if (document.hidden) return 20000;
    // 无凭证（未配对/旧 Cookie 丢了）：退避到 30s，避免每 2.5s 一次无谓 401
    if (NS.noAuth) return 30000;
    return NS.lastPayload && NS.lastPayload.mine ? 2500 : 4000;
  }

  function poll() {
    if (inflightReq) return;
    var sid = currentSid();
    NS.sid = sid;

    // overlay 可能列了「想看」的会话（插件原版的分屏机制），一起带上
    var want = [];
    try {
      if (Array.isArray(window.__zusageWantSids)) want = window.__zusageWantSids.slice(0, 6);
      else if (window.__zusageWantSid) want = [window.__zusageWantSid];
    } catch (e) {}
    var sids = [];
    if (sid) sids.push(sid);
    want.forEach(function (s) { if (s && sids.indexOf(s) < 0) sids.push(s); });

    inflightReq = fetch(snapshotUrl(sids, sid), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { NS.noAuth = true; NS.diag.noAuth = true; throw new Error('HTTP 401（未配对）'); }
        NS.noAuth = false; NS.diag.noAuth = false;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        NS.diag.polls++;
        NS.lastPayload = d;
        d.mine = sid;
        try { window.__zusageUpdate && window.__zusageUpdate(d); } catch (e) {
          NS.diag.errors++; NS.diag.lastError = 'update: ' + e.message;
        }
      })
      .catch(function (e) {
        NS.diag.errors++; NS.diag.lastError = String(e.message || e);
      })
      .then(function () { inflightReq = null; schedule(); });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(poll, cadence());
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) schedule(); else poll();
  }, true);
  window.addEventListener('online', poll);

  /* ZCode 页面的 SW 注册 / 刷新+崩溃遥测 / 移动端 App 兼容标记已迁往
   * /zcode-boot-probe.js（随 ZCode web dist 发布，nginx sub_filter 并列注入），
   * 本脚本回归状态栏旁挂服务的单一职责：数据泵 + overlay 注入。 */

  function start() {
    injectOverlay();
    poll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
