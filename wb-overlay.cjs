#!/usr/bin/env node
/* WorkBuddy 用量浮层注入器（CDP，零依赖）。
 *
 * 为什么需要它：ZCode 的状态条靠 asar 注入（inject-main.cjs → overlay.js），WorkBuddy
 * 没有这条链，也不该去改它的程序文件。WorkBuddy 主进程带 --remote-debugging-port，
 * 于是改用 CDP 往渲染进程注入一个自绘胶囊——和 zcode-beautify 改 UI 是同一路子。
 *
 * 形态：输入卡内底部一条状态行（与 ZCode 版视觉对齐）；每个分段悬停弹信息卡，
 * 右侧齿轮点开完整详情。速度卡的柱状图/颜色档位/统计口径照 ZCode 的悬浮说明做。
 * 挂载点随宿主重渲染重贴回卡片；找不到卡片才退回窗口右下角。
 *
 * 数据：自己拉起 `zusage.py serve`（一行一请求），按间隔取快照，推给页面。
 *
 * 单实例：临时目录里的 lock 文件（pid + 心跳 mtime），过期即视为残留。
 * 退出：页面关闭/CDP 断开重试若干次；lock 过期后由下一次启动接管。
 *
 * 手动跑：node wb-overlay.cjs [--port 9335] [--interval 2500] [--once]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.ZUSAGE_CDP_PORT || argOf('--port') || 9335);
const INTERVAL = Number(process.env.ZUSAGE_OVERLAY_INTERVAL || argOf('--interval') || 2500);
const ONCE = process.argv.includes('--once');
const HOST = process.env.ZUSAGE_HOST || 'workbuddy';
const SCRIPT = path.join(__dirname, 'zusage.py');
const LOCK = path.join(os.tmpdir(), 'zusage-wb-overlay.lock');
const MAX_RETRY = 12;

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

function log(...a) {
  process.stderr.write('[zusage-overlay] ' + a.join(' ') + '\n');
}

/* ---------- 单实例 ---------- */

function liveLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    const age = Date.now() - (Number(raw.at) || 0);
    if (!Number.isFinite(age) || age > Math.max(15000, INTERVAL * 4)) return null;
    if (raw.pid && raw.pid !== process.pid) {
      try { process.kill(raw.pid, 0); } catch (e) { return null; }   // 进程已不在
      return raw;
    }
    return raw.pid === process.pid ? raw : null;
  } catch (e) {
    return null;
  }
}

function touchLock(extra) {
  try {
    fs.writeFileSync(LOCK, JSON.stringify(Object.assign({ pid: process.pid, at: Date.now() }, extra || {})));
  } catch (e) { /* 锁写失败不影响注入 */ }
}

function dropLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (raw.pid === process.pid) fs.unlinkSync(LOCK);
  } catch (e) { /* ignore */ }
}

/* ---------- CDP ---------- */

function listTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 4000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try {
          const list = JSON.parse(buf);
          const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          const main = pages.find((t) => String(t.url).includes('renderer/index.html')) || pages[0];
          resolve(main || null);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CDP list timeout')));
    req.on('error', reject);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e);
      return;
    }
    const pending = new Map();
    let seq = 0;
    ws.addEventListener('open', () => resolve({
      call(method, params) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        return new Promise((res2, rej2) => {
          pending.set(id, { res2, rej2 });
          setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); rej2(new Error('CDP call timeout: ' + method)); }
          }, 5000);
        });
      },
      close() { try { ws.close(); } catch (e) { /* ignore */ } },
      get open() { return ws.readyState === 1; },
    }));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej2(new Error(msg.error.message || 'CDP error'));
        else p.res2(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')));
    ws.addEventListener('close', () => {
      for (const [, p] of pending) p.rej2(new Error('CDP closed'));
      pending.clear();
    });
  });
}

/* ---------- 数据 ---------- */

function startPython() {
  if (!fs.existsSync(SCRIPT)) return null;
  const env = Object.assign({}, process.env, { ZUSAGE_HOST: HOST, PYTHONIOENCODING: 'utf-8' });
  const child = spawn(process.env.ZUSAGE_PYTHON || 'python', ['-B', SCRIPT, 'serve'], {
    cwd: __dirname, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  let buf = '';
  let waiter = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      if (waiter) { const w = waiter; waiter = null; w(line); }
    }
  });
  child.on('error', (e) => log('python spawn failed:', e.message));
  return {
    query() {
      return new Promise((resolve) => {
        if (!child.stdin.writable) { resolve(null); return; }
        waiter = resolve;
        child.stdin.write('\n');
        setTimeout(() => { if (waiter === resolve) { waiter = null; resolve(null); } }, 5000);
      });
    },
    stop() { try { child.kill(); } catch (e) { /* ignore */ } },
  };
}

function toPayload(snap) {
  if (!snap || snap.error) return null;
  const s = snap.session || {};
  const today = snap.today || {};
  const proj = snap.project || {};
  const turn = snap.last_turn || {};
  const tools = snap.tools || {};
  const cw = Number(s.context_window || snap.context_window || 0);
  const used = Number(s.ctx || 0);
  // 费用可能是 null（模型未收录价表）：保留 null 让页面写「不可得」，不要折成 0
  const money = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const unknown = Array.from(new Set([].concat(s.cost_unknown || [], today.cost_unknown || []))).slice(0, 4);
  return {
    ok: !snap.local_error,
    ctx: used, cw,
    pct: cw > 0 ? (used / cw) * 100 : 0,
    credits: Number(s.credits || 0),
    turns: Number(s.turns || 0),
    requests: Number(s.requests || 0),
    total: Number(s.total || 0),
    input: Number(s.input || 0),
    output: Number(s.output || 0),
    reasoning: Number(s.reasoning || 0),
    cacheRead: Number(s.cache_read || 0),
    cacheWrite: Number(s.cache_write || 0),
    toolCalls: Number(tools.total || 0),
    toolErrors: Number(tools.errors || 0),
    tps: Number(s.avg_tps || 0),
    lastTps: Number((snap.last || {}).tps || 0),
    turnTotal: Number(turn.total || 0),
    turnRequests: Number(turn.requests || 0),
    turnTps: Number(turn.tps || 0),
    todayTotal: Number(today.total || 0),
    todayRequests: Number(today.requests || 0),
    todaySessions: Number(today.sessions || 0),
    todayCredits: Number(today.credits || 0),
    projTotal: Number(proj.total || 0),
    projSessions: Number(proj.sessions || 0),
    sessionCost: money(s.cost_usd),
    turnCost: money(turn.cost_usd),
    todayCost: money(today.cost_usd),
    projCost: money(proj.cost_usd),
    costPartial: !!(s.cost_partial || today.cost_partial || proj.cost_partial),
    costUnknown: unknown,
    fxRate: Number((snap.fx || {}).rate || 0),
    title: String(s.title || ''),
    model: String(s.model || ''),
    cwd: String(s.cwd || ''),
    active: !!s.active,
    host: String(snap.host || HOST),
    toolList: (tools.list || []).slice(0, 8),
    models: (today.models || []).slice(0, 6),
    // ---- 悬停信息卡（对齐 ZCode 的分段悬浮说明）----
    speedPoints: (s.speed_points || []).slice(-10),
    sessionStarted: Number(s.started || 0),
    sessionLastAt: Number(s.last_at || 0),
    turnDetail: {
      requests: Number(turn.requests || 0),
      input: Number(turn.input || 0),
      output: Number(turn.output || 0),
      reasoning: Number(turn.reasoning || 0),
      cacheRead: Number(turn.cache_read || 0),
      total: Number(turn.total || 0),
      tps: Number(turn.tps || 0),
      cost: money(turn.cost_usd),
      durationMs: Number(turn.duration_ms || 0),
      avgDurationMs: Number(turn.avg_duration_ms || 0),
      toolCalls: Number(turn.tool_calls || 0),
      toolErrors: Number(turn.tool_errors || 0),
      started: Number(turn.started || 0),
      ended: Number(turn.ended || 0),
      model: String(s.model || ''),
      models: (turn.cost_models || []).slice(0, 6),
    },
    sessionDetail: {
      title: String(s.title || ''), model: String(s.model || ''),
      turns: Number(s.turns || 0), requests: Number(s.requests || 0),
      input: Number(s.input || 0), output: Number(s.output || 0),
      reasoning: Number(s.reasoning || 0), cacheRead: Number(s.cache_read || 0),
      total: Number(s.total || 0), tps: Number(s.avg_tps || 0),
      lastTps: Number((snap.last || {}).tps || 0),
      cost: money(s.cost_usd), credits: Number(s.credits || 0),
      toolCalls: Number(tools.total || 0), toolErrors: Number(tools.errors || 0),
      models: (s.models || []).slice(0, 6),
      started: Number(s.started || 0), lastAt: Number(s.last_at || 0),
    },
    todayDetail: {
      sessions: Number(today.sessions || 0),
      newSessions: Number(today.new_sessions || 0),
      requests: Number(today.requests || 0),
      input: Number(today.input || 0), output: Number(today.output || 0),
      reasoning: Number(today.reasoning || 0), cacheRead: Number(today.cache_read || 0),
      total: Number(today.total || 0), credits: Number(today.credits || 0),
      cost: money(today.cost_usd), models: (today.models || []).slice(0, 6),
      toolCalls: Number(today.tool_calls || 0), toolErrors: Number(today.tool_errors || 0),
      firstAt: Number(today.first_at || 0), lastAt: Number(today.last_at || 0),
    },
    projectDetail: {
      sessions: Number(proj.sessions || 0), requests: Number(proj.requests || 0),
      turns: Number(proj.turns || 0), toolCalls: Number(proj.tool_calls || 0),
      input: Number(proj.input || 0), output: Number(proj.output || 0),
      cacheRead: Number(proj.cache_read || 0),
      toolErrors: Number(proj.tool_errors || 0),
      total: Number(proj.total || 0), cost: money(proj.cost_usd),
      models: (proj.models || []).slice(0, 6),
      firstAt: Number(proj.first_at || 0), lastAt: Number(proj.last_at || 0),
    },
    dbPath: String(snap.db_path || ''),
    contextAuto: !!snap.context_auto,
  };
}

/* ---------- 注入到页面的脚本（自包含，幂等） ---------- */

const PAGE_VERSION = 'wb-2.9.0';   // 页面脚本版本：一致就复用，升级后下一次 tick 自动重建
const PAGE_SCRIPT = `(function(){
  var ID = 'zusage-wb-bar';
  var VER = '${PAGE_VERSION}';
  /* 注入器每 2.5s 调一次本脚本：版本一致且节点还在时**必须直接复用**。
     之前无条件「先销毁再重建」，导致状态条每个 tick 闪一下（用户报的消失/闪烁）。
     只有版本变了才重建，让热更在下一次 tick 生效。 */
  if (window.__zusageWB_version === VER && window.__zusageWB_update) {
    var cur = document.getElementById(ID);
    if (cur && cur.isConnected) return 'exists';
  }
  /* 版本不一致才走销毁重建：旧实例的监听绑在旧节点上、旧浮层还挂在 body 里，
     跳过会留下同 id 的孤儿节点。querySelectorAll 才删得干净（getElementById 只删第一个）。 */
  if (window.__zusageWB_destroy) { try { window.__zusageWB_destroy(); } catch (e) {} }
  document.querySelectorAll('#zusage-wb-bar, #zusage-wb-pill, #zusage-wb-bar-pop, #zusage-wb-bar-style, #zusage-wb-tip, #zusage-wb-tip-style, #zusage-wb-bar-set, #zusage-wb-bar-set-style')
    .forEach(function(n){ n.remove(); });

  /* ---------- 本地偏好（设置面板持久化，对齐 ZCode 状态条 ⚙ 设置） ---------- */
  var PREF_KEY = 'zusagewb.prefs';
  var SHOW_ITEMS = [
    { k: 'spd',   label: '生成速度',  desc: '最近一段的实时 t/s（悬停看柱状图与档位）' },
    { k: 'turn',  label: '本轮',      desc: '本轮 tokens 与请求次数' },
    { k: 'sess',  label: '会话累计',  desc: '本会话的轮数与请求次数' },
    { k: 'tool',  label: '工具调用',  desc: '调用次数与错误数（悬停看各工具明细）' },
    { k: 'today', label: '今日合计',  desc: '今天所有会话的 tokens 与请求数' },
    { k: 'ctx',   label: '上下文',    desc: '上下文窗口占用百分比' },
    { k: 'proj',  label: '项目累计',  desc: '本项目所有会话的消耗' }
  ];
  function readPrefs(){
    var raw = null, out = { show: {}, just: 'between', cnNum: false };
    try { raw = JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); } catch (e) { raw = null; }
    if (raw && typeof raw === 'object') {
      if (raw.show && typeof raw.show === 'object') {
        for (var i = 0; i < SHOW_ITEMS.length; i++) {
          var k = SHOW_ITEMS[i].k;
          if (typeof raw.show[k] === 'boolean') out.show[k] = raw.show[k];
        }
      }
      if (raw.just === 'start' || raw.just === 'end' || raw.just === 'between') out.just = raw.just;
      out.cnNum = !!raw.cnNum;
    }
    return out;
  }
  function savePrefs(){ try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} }
  var prefs = readPrefs();

  var fmt = function(n){
    n = Number(n) || 0;
    if (prefs.cnNum) {
      if (n >= 1e8) return (n/1e8).toFixed(2) + '亿';
      if (n >= 1e4) return (n/1e4).toFixed(2) + '万';
      return String(Math.round(n));
    }
    if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  };
  var num = function(n){ return String(Number(n) || 0); };
  var fxRate = 0;
  function money(usd){
    if (usd === null || usd === undefined || !isFinite(usd)) return '—';
    if (fxRate > 0) { var v = usd * fxRate; return (v > 0 && v < 0.01) ? '<¥0.01' : '¥' + v.toFixed(2); }
    return (usd > 0 && usd < 0.01) ? '<$0.01' : '$' + usd.toFixed(2);
  }
  var band = function(p){
    if (p >= 90) return 'crit';
    if (p >= 80) return 'high';
    if (p >= 50) return 'mid';
    if (p >= 30) return 'norm';
    return 'calm';
  };
  var ICON = {
    st: '',
    spd: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 1.5 3 9h5l-1 5.5L13 7H8.5l.5-5.5z"/></svg>',
    turn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.6 3.4h10.8a1 1 0 011 1v6.2a1 1 0 01-1 1H6.4L3 14V4.4a1 1 0 011-1z"/></svg>',
    sess: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.4" y="2.6" width="11.2" height="10.8" rx="2"/><path d="M2.4 6.2h11.2M5.6 9.4h4.8"/></svg>',
    tool: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.8 2.2a3.6 3.6 0 00-3.2 5.2L2.3 11.7a1.9 1.9 0 002.7 2.7l4.3-4.3a3.6 3.6 0 004.5-4.4l-2.3 1.7-2.1-2.1 1.7-2.3a3.6 3.6 0 00-1.3-.8z"/></svg>',
    today: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.3" y="3.4" width="11.4" height="10.3" rx="2"/><path d="M2.3 6.6h11.4M5.5 1.8v3M10.5 1.8v3"/></svg>',
    ctx: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M8 8V4.4"/></svg>',
    cr: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.2" y="4.6" width="11.6" height="7.4" rx="2"/><path d="M2.2 7.6h11.6"/></svg>',
    proj: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.9 4.2a1 1 0 011-1h3.3l1.4 1.7h5.5a1 1 0 011 1v6.9a1 1 0 01-1 1H2.9a1 1 0 01-1-1z"/></svg>',
    info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5.9"/><path d="M8 7.3v3.6M8 5.2v.9"/></svg>',
    /* 设置：滑杆图标——11px 下齿轮的放射齿会糊成“太阳”，滑杆的横向线条更易识别，
       且线条在旋钮处断开、不填底色，悬停高亮时也不会出现色块。 */
    sliders: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">'
      + '<path d="M2.6 4.8H9M11.2 4.8h2.2M2.6 8h1.6M5.4 8h8M2.6 11.2h4.2M9.8 11.2h3.6"/>'
      + '<circle cx="10.1" cy="4.8" r="1.4"/><circle cx="4.4" cy="8" r="1.4"/>'
      + '<circle cx="8.8" cy="11.2" r="1.4"/></svg>'
  };

  var css = ''
    + '#' + ID + '{position:relative;display:flex;align-items:center;width:100%;box-sizing:border-box;order:9999;'
    + 'padding:5px 16px 8px 14px;'
    + 'font:11px/1.4 "Segoe UI",system-ui,sans-serif;color:rgba(255,255,255,.55);'
    + 'white-space:nowrap;user-select:none}'
    + '#' + ID + '::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:rgba(255,255,255,.07)}'
    /* 分段按输入框宽度均摊：flex-grow 吃掉剩余宽度（按内容宽度等比放大，不会被挤成等宽格子），
       段内内容居中、分隔线落在格子边界上；首/末**可见**段贴边。贴边不能写死 :first-child /
       :last-of-type——设置面板关掉某几段后，贴边目标会变，脚本按当前显隐打 .first/.end。 */
    + '#' + ID + ' .it{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:0 9px;'
    + 'height:18px;flex:1 1 auto;min-width:0;overflow:hidden}'
    + '#' + ID + ' .it.first{justify-content:flex-start;padding-left:0}'
    + '#' + ID + ' .it.end{justify-content:flex-end;padding-right:0}'
    + '#' + ID + ' .it+.it{border-left:1px solid rgba(255,255,255,.13)}'
    + '#' + ID + ' .it{border-radius:4px;transition:background .12s}'
    + '#' + ID + ' .it:hover{background:rgba(255,255,255,.08)}'
    + '#' + ID + ' svg{width:11px;height:11px;flex:0 0 auto;opacity:.7}'
    + '#' + ID + ' .v{color:rgba(255,255,255,.88);font-variant-numeric:tabular-nums}'
    + '#' + ID + ' .b{font-weight:600;color:rgba(255,255,255,.93);font-variant-numeric:tabular-nums}'
    + '#' + ID + ' .dim{opacity:.55}'
    + '#' + ID + ' .err{color:#f87171}'
    + '#' + ID + '.calm .pct{color:#4ade80}'
    + '#' + ID + '.norm .pct{color:#60a5fa}'
    + '#' + ID + '.mid .pct{color:#fbbf24}'
    + '#' + ID + '.high .pct{color:#fb923c}'
    + '#' + ID + '.crit .pct{color:#f87171}'
    + '#' + ID + '.stale .it, #' + ID + '.stale .info, #' + ID + '.stale .set{opacity:.45}'
    + '#' + ID + '.stale .dot{background:#71717a;box-shadow:none}'
    + '#' + ID + ' .dot{width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 2px rgba(74,222,128,.16);flex:0 0 auto}'
    + '#' + ID + ' .st.bad .dot{background:#fbbf24;box-shadow:0 0 0 2px rgba(251,191,36,.16)}'
    + '#' + ID + ' .st.bad .sts{color:#fbbf24}'
    /* 右侧两个按钮：ℹ 详情浮层、⚙ 设置面板（对齐 ZCode 状态条的 ⚙ 设置）。 */
    + '#' + ID + ' .info, #' + ID + ' .set{margin-left:8px;display:inline-flex;align-items:center;justify-content:center;'
    + 'width:18px;height:18px;border-radius:5px;cursor:pointer;color:rgba(255,255,255,.72);flex:0 0 auto}'
    + '#' + ID + ' .info:hover, #' + ID + ' .set:hover{opacity:1;background:rgba(255,255,255,.10)}'
    + '#' + ID + ' .set.on{background:rgba(255,255,255,.13);color:#fff}'
    /* 排布模式（设置面板「排布」）：jstart 居左、jend 居右，默认均分。 */
    + '#' + ID + '.jstart .it{flex:0 1 auto}'
    + '#' + ID + '.jstart .info{margin-left:auto}'   /* 两个按钮里 info 在前，auto 挂它才能一起贴右 */
    + '#' + ID + '.jend{justify-content:flex-end}'
    + '#' + ID + '.jend .it{flex:0 1 auto}'
    + '#' + ID + '.fallback{position:fixed;right:14px;bottom:96px;z-index:2147483000;width:auto;'
    + 'border-radius:12px;background:rgba(24,24,28,.94);border:1px solid rgba(127,127,127,.28);'
    + 'padding:5px 10px;box-shadow:0 2px 10px rgba(0,0,0,.24)}';

  var st = document.createElement('style');
  st.id = ID + '-style';
  st.textContent = css;
  document.head.appendChild(st);

  var bar = document.createElement('div');
  bar.id = ID;
  bar.innerHTML =
      '<span class="it st"><span class="dot"></span><span class="sts">本地库</span></span>'
    + '<span class="it spd">' + ICON.spd + '<span class="b spdv">--</span><span class="dim">t/s</span></span>'
    + '<span class="it turn">' + ICON.turn + '<span class="b turnv">--</span><span class="dim turnr"></span></span>'
    + '<span class="it sess">' + ICON.sess + '<span class="v sessv">--</span><span class="dim sessr"></span></span>'
    + '<span class="it tool">' + ICON.tool + '<span class="v toolv">--</span><span class="err toolerr"></span></span>'
    + '<span class="it today">' + ICON.today + '<span class="v todayv">--</span><span class="dim todayr"></span></span>'
    + '<span class="it ctx">' + ICON.ctx + '<span class="b pct">--</span></span>'
    + '<span class="it proj">' + ICON.proj + '<span class="v projv">--</span></span>'
    + '<span class="info" title="详情" aria-label="完整数据详情">' + ICON.info + '</span>'
    + '<span class="set" title="状态条设置" aria-label="打开状态条设置" aria-haspopup="dialog">' + ICON.sliders + '</span>';

  /* 浮层挂 body 而不是状态条内部：输入卡是独立层叠上下文，挂在里面会被工具栏盖住、
     也会被卡片圆角/overflow 裁掉。fixed + 每次打开按状态条位置重算，视觉上仍贴着它。 */
  var pop = document.createElement('div');
  pop.id = ID + '-pop';
  pop.style.cssText = 'display:none;position:fixed;z-index:2147483600;'
    + 'min-width:260px;max-width:360px;padding:9px 11px;border-radius:10px;'
    + 'background:#1c1c20;border:1px solid rgba(255,255,255,.12);'
    + 'box-shadow:0 8px 26px rgba(0,0,0,.5);font:11.5px/1.6 "Segoe UI",system-ui,sans-serif;'
    + 'color:rgba(255,255,255,.72);white-space:normal;text-align:left';
  document.body.appendChild(pop);

  var lastPayload = {};
  var lastAt = 0;

  function esc(v){ return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function row(k, v, cls){
    return '<div style="display:flex;gap:8px;align-items:baseline">'
      + '<span style="flex:0 0 62px;opacity:.5">' + esc(k) + '</span>'
      + '<span style="flex:1 1 auto;color:rgba(255,255,255,.9)' + (cls ? ';' + cls : '') + '">' + v + '</span></div>';
  }
  function renderPop(d){
    var hit = d.input > 0 ? Math.round((d.cacheRead || 0) / d.input * 100) : 0;
    var tools = (d.toolList || []).map(function(t){
      return esc(t.name) + ' ' + t.count + (t.errors ? '（错 ' + t.errors + '）' : '');
    }).join('　');
    var models = (d.models || []).map(function(m){
      return esc(m.model) + ' ' + fmt(m.total)
        + ' ' + (m && m.priced && m.cost_usd != null ? money(m.cost_usd) : '—');
    }).join('　');
    var html = [
      row('会话', esc(d.title || '—')),
      row('模型', esc(d.model || '—') + (d.active ? ' · 进行中' : '')),
      row('上下文', fmt(d.ctx) + ' / ' + fmt(d.cw) + '（' + (Number(d.pct) || 0).toFixed(1) + '%）'),
      '<div style="height:1px;background:rgba(255,255,255,.08);margin:6px 0"></div>',
      row('本轮', fmt(d.turnTotal) + ' tokens · ' + num(d.turnRequests) + ' 次 · '
          + (d.turnTps ? d.turnTps + ' t/s' : '速度 —')),
      row('会话累计', fmt(d.total) + ' tokens · ' + num(d.turns) + ' 轮 / ' + num(d.requests) + ' 次'),
      row('分项', '入 ' + fmt(d.input) + '（缓存命中 ' + hit + '%）· 出 ' + fmt(d.output)
          + (d.reasoning ? '（思考 ' + fmt(d.reasoning) + '）' : '')),
      row('预估费用', (d.sessionCost == null && d.todayCost == null)
          ? '不可得（价表未收录 ' + esc((d.costUnknown || []).join('、') || '该模型') + '）'
          : '本轮 ' + money(d.turnCost) + ' · 会话 ' + money(d.sessionCost)
            + ' · 今日 ' + money(d.todayCost)
            + (d.costPartial
                ? '<div style="opacity:.7;margin-top:2px">不含未收录模型 '
                  + esc((d.costUnknown || []).join('、')) + '</div>'
                : '')
            + '<div style="opacity:.7;margin-top:2px">按价表牌价估算，非账单</div>'),
      row('速度', (d.tps ? '会话均 ' + d.tps + ' t/s' : '均 —')
          + (d.lastTps ? ' · 最近一段 ' + d.lastTps + ' t/s' : '')),
      row('工具', num(d.toolCalls) + ' 次' + (d.toolErrors ? '（错误 ' + d.toolErrors + '）' : '')
          + (tools ? '<div style="opacity:.72;margin-top:2px">' + tools + '</div>' : '')),
      row('credit', (Number(d.credits) || 0).toFixed(2) + '（宿主计费口径，不是账单）'),
      '<div style="height:1px;background:rgba(255,255,255,.08);margin:6px 0"></div>',
      row('今日', fmt(d.todayTotal) + ' tokens · ' + num(d.todayRequests) + ' 次 · '
          + num(d.todaySessions) + ' 会话 · ' + (Number(d.todayCredits) || 0).toFixed(2) + ' credit'),
      (models ? row('今日模型', models) : ''),
      row('项目累计', (d.projSessions ? fmt(d.projTotal) + ' tokens · ' + num(d.projSessions) + ' 会话' : '—')),
      '<div style="opacity:.45;margin-top:6px;line-height:1.5">'
        + '数据源：本地会话正文的逐次调用用量 + 会话上下文；'
        + '费用按价表牌价估算（未收录模型标 —，不按兜底均价冒充）。'
        + '</div>'
    ].join('');
    pop.innerHTML = html;
  }

  ['pointerdown', 'click'].forEach(function(type){
    document.addEventListener(type, function(ev){
      if (!pop.contains(ev.target) && !bar.contains(ev.target)) pop.style.display = 'none';
    }, true);
  });
  /* 宿主在输入卡的按下阶段做了处理，真实鼠标的 click 到不了这里（程序化 click 能到），
     所以绑 pointerdown 并就地吞掉事件；老内核退回 click。 */
  var infoEl = bar.querySelector('.info');
  function placePop(){
    var r = bar.getBoundingClientRect();
    var w = pop.offsetWidth || 300, h = pop.offsetHeight || 320;
    var left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    var top = r.top - h - 8;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(Math.max(8, top)) + 'px';
  }
  function togglePop(ev){
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    var open = pop.style.display !== 'block';
    if (open) {
      closeSet();   // 两个浮层互斥，避免叠在一起
      hideTip(); renderPop(lastPayload); pop.style.display = 'block'; placePop();
    }
    else pop.style.display = 'none';
  }
  if (window.PointerEvent) infoEl.addEventListener('pointerdown', togglePop, true);
  else infoEl.addEventListener('click', togglePop);

  /* ---------- 悬停信息卡（对齐 ZCode 的分段悬浮说明） ---------- */
  /* 分段档位：与 ZCode 同一套颜色语义（低速红 → 高速紫），悬停速度卡里画柱状图 */
  var TB = [
    { lo: 2000, cls: 'ultra',   label: '≥2000', zh: 'Ultra' },
    { lo: 1000, cls: 'magenta', label: '1000-2000', zh: '极高速' },
    { lo: 800,  cls: 'purple',  label: '800-1000', zh: '超高速' },
    { lo: 500,  cls: 'violet',  label: '500-800', zh: '极速' },
    { lo: 300,  cls: 'azure',   label: '300-500', zh: '高速' },
    { lo: 200,  cls: 'sky',     label: '200-300', zh: '快速' },
    { lo: 150,  cls: 'teal',    label: '150-200', zh: '较快' },
    { lo: 70,   cls: 'ok',      label: '70-150', zh: '流畅' },
    { lo: 40,   cls: 'warm',    label: '40-70', zh: '一般' },
    { lo: 0,    cls: 'hot',     label: '<40', zh: '低速' }
  ];
  function tband(v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return null;
    for (var i = 0; i < TB.length; i++) if (v >= TB[i].lo) return TB[i];
    return TB[TB.length - 1];
  }
  function clockSec(ts) {
    var d = new Date(Number(ts) || 0);
    if (!ts || isNaN(d.getTime())) return '--:--:--';
    return clockOf(ts) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function clockOf(ts) {
    var d = new Date(Number(ts) || 0);
    if (!ts || isNaN(d.getTime())) return '--:--';
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function stampOf(ts) {
    var d = new Date(Number(ts) || 0);
    if (!ts || isNaN(d.getTime())) return '—';
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    var ss = ('0' + d.getSeconds()).slice(-2);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-'
      + ('0' + d.getDate()).slice(-2) + ' ' + hh + ':' + mm + ':' + ss;
  }
  function moneyOr(usd) { return usd === null || usd === undefined ? '—' : money(usd); }

  var tipCss = ''
    + '#zusage-wb-tip{position:fixed;z-index:2147483500;display:none;width:max-content;'
    + 'max-width:min(560px,calc(100vw - 24px));padding:12px 14px;border-radius:12px;'
    + 'background:#1b1b1f;border:1px solid rgba(255,255,255,.12);'
    + 'box-shadow:0 12px 34px rgba(0,0,0,.55);color:rgba(255,255,255,.72);'
    + 'font:12px/1.55 "Segoe UI",system-ui,sans-serif;white-space:normal;text-align:left}'
    + '#zusage-wb-tip.zwt-wide{width:min(860px,calc(100vw - 24px));max-width:none}'
    + '#zusage-wb-tip .zwt-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}'
    + '#zusage-wb-tip .zwt-title{font-size:15px;font-weight:600;color:rgba(255,255,255,.94)}'
    + '#zusage-wb-tip .zwt-scope{margin-left:auto;padding:2px 10px;border-radius:999px;'
    + 'border:1px solid rgba(255,255,255,.18);font-size:11px;color:rgba(255,255,255,.62)}'
    + '#zusage-wb-tip .zwt-row{display:flex;gap:10px;align-items:baseline;margin:3px 0}'
    + '#zusage-wb-tip .zwt-k{flex:0 0 66px;color:rgba(255,255,255,.45)}'
    + '#zusage-wb-tip .zwt-v{flex:1 1 auto;color:rgba(255,255,255,.9);font-variant-numeric:tabular-nums}'
    + '#zusage-wb-tip .zwt-note{margin-top:7px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);'
    + 'color:rgba(255,255,255,.45);font-size:11px;line-height:1.5}'
    + '#zusage-wb-tip .zwt-sep{height:1px;background:rgba(255,255,255,.08);margin:7px 0}'
    /* ---- 速度卡：左卡 + 右图 + 图例 + 口径（对齐 ZCode 悬浮说明） ---- */
    + '#zusage-wb-tip .zwt-speed{display:flex;gap:16px;align-items:stretch}'
    + '#zusage-wb-tip .zwt-left{flex:0 0 232px;box-sizing:border-box;padding:12px 13px;'
    + 'border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.028)}'
    + '#zusage-wb-tip .zwt-status{display:flex;align-items:center;gap:6px;color:#f5b944;font-size:12px}'
    + '#zusage-wb-tip .zwt-status svg{width:15px;height:15px;flex:0 0 auto}'
    + '#zusage-wb-tip .zwt-status.active{color:#3ecf8e}'
    + '#zusage-wb-tip .zwt-rd{margin-top:10px;font-size:10.5px;color:rgba(255,255,255,.42)}'
    + '#zusage-wb-tip .zwt-big{display:flex;align-items:baseline;gap:4px;margin-top:2px}'
    + '#zusage-wb-tip .zwt-big small{font-size:12px;color:rgba(255,255,255,.5)}'
    + '#zusage-wb-tip .zwt-big b{font-size:36px;line-height:1.05;font-weight:600;'
    + 'letter-spacing:-1px;color:rgba(255,255,255,.95)}'
    + '#zusage-wb-tip .zwt-big i{font-style:normal;font-size:11px;color:rgba(255,255,255,.45)}'
    + '#zusage-wb-tip .zwt-band{display:inline-block;margin-top:8px;padding:2px 8px;'
    + 'border-radius:999px;font-size:11px;border:1px solid currentColor;background:rgba(255,255,255,.04)}'
    + '#zusage-wb-tip .zwt-sub{margin-top:6px;font-size:10.5px;color:rgba(255,255,255,.4)}'
    + '#zusage-wb-tip .zwt-stats{display:flex;margin-top:12px;padding-top:10px;'
    + 'border-top:1px solid rgba(255,255,255,.08)}'
    + '#zusage-wb-tip .zwt-stat{flex:1 1 0;text-align:center;min-width:0}'
    + '#zusage-wb-tip .zwt-stat+.zwt-stat{border-left:1px solid rgba(255,255,255,.08)}'
    + '#zusage-wb-tip .zwt-stat i{display:block;font-style:normal;font-size:10px;color:rgba(255,255,255,.4)}'
    + '#zusage-wb-tip .zwt-stat b{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}'
    + '#zusage-wb-tip .zwt-chart{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}'
    + '#zusage-wb-tip .zwt-chead{display:flex;align-items:baseline;gap:8px;font-size:10.5px;'
    + 'color:rgba(255,255,255,.45)}'
    + '#zusage-wb-tip .zwt-chead b{font-size:12.5px;font-weight:600;color:rgba(255,255,255,.85)}'
    + '#zusage-wb-tip .zwt-unitr{margin-left:auto;font-size:10.5px}'
    + '#zusage-wb-tip .zwt-plot{position:relative;margin-top:10px;padding-left:30px;flex:1 1 auto}'
    + '#zusage-wb-tip .zwt-axis{position:absolute;left:0;top:0;bottom:26px;width:28px;'
    + 'font-size:10px;color:rgba(255,255,255,.35)}'
    + '#zusage-wb-tip .zwt-axis span{position:absolute;right:4px;transform:translateY(50%)}'
    + '#zusage-wb-tip .zwt-grid{position:absolute;left:30px;right:0;height:0;'
    + 'border-top:1px dashed rgba(255,255,255,.10)}'
    + '#zusage-wb-tip .zwt-cols{position:relative;display:flex;align-items:flex-end;gap:14px;'
    + 'height:150px;border-bottom:1px solid rgba(255,255,255,.16)}'
    + '#zusage-wb-tip .zwt-col{flex:1 1 0;display:flex;flex-direction:column;'
    + 'justify-content:flex-end;align-items:center;gap:3px;min-width:0}'
    + '#zusage-wb-tip .zwt-col b{font-size:10.5px;font-weight:500;color:rgba(255,255,255,.72)}'
    + '#zusage-wb-tip .zwt-bar{display:block;width:100%;max-width:20px;min-height:2px;'
    + 'border-radius:4px 4px 0 0;background:currentColor}'
    + '#zusage-wb-tip .zwt-times{display:flex;gap:14px;margin-top:5px;padding-left:30px}'
    + '#zusage-wb-tip .zwt-times span{flex:1 1 0;text-align:center;font-size:10px;'
    + 'color:rgba(255,255,255,.4);min-width:0;line-height:1.35}'
    + '#zusage-wb-tip .zwt-times i{display:block;font-style:normal;opacity:.62}'
    + '#zusage-wb-tip .zwt-legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;'
    + 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);font-size:11px}'
    + '#zusage-wb-tip .zwt-legend em{font-style:normal;color:rgba(255,255,255,.5);'
    + 'font-weight:500;margin-right:2px}'
    + '#zusage-wb-tip .zwt-legend span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}'
    + '#zusage-wb-tip .zwt-legend i{width:6px;height:6px;border-radius:50%;background:currentColor}'
    + '#zusage-wb-tip .zwt-legend .ultra b{background:linear-gradient(100deg,#60a5fa,#a78bfa,#c084fc);'
    + '-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:600}'
    + '#zusage-wb-tip .zwt-basis{margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.08)}'
    + '#zusage-wb-tip .zwt-basis h4{margin:0 0 6px;font-size:13px;font-weight:600;'
    + 'color:rgba(255,255,255,.9)}'
    + '#zusage-wb-tip .zwt-basis p{margin:2px 0;font-size:11.5px;color:rgba(255,255,255,.62)}'
    + '#zusage-wb-tip .zwt-basis small{display:block;margin-top:3px;font-size:10.5px;'
    + 'color:rgba(255,255,255,.4);line-height:1.55}'
    + '#zusage-wb-tip .hot{color:#ff6b57}#zusage-wb-tip .warm{color:#f5b944}'
    + '#zusage-wb-tip .ok{color:#3ecf8e}#zusage-wb-tip .teal{color:#2dd4bf}'
    + '#zusage-wb-tip .sky{color:#38bdf8}#zusage-wb-tip .azure{color:#6d9fff}'
    + '#zusage-wb-tip .violet{color:#9b8cff}#zusage-wb-tip .purple{color:#bb86fc}'
    + '#zusage-wb-tip .magenta{color:#d88cff}#zusage-wb-tip .ultra{color:#a78bfa}'
    + '#zusage-wb-tip .zwt-ctxbar{height:6px;border-radius:4px;background:rgba(255,255,255,.1);'
    + 'overflow:hidden;margin:6px 0}'
    + '#zusage-wb-tip .zwt-ctxbar i{display:block;height:100%;border-radius:4px;background:#60a5fa}'
    + '#zusage-wb-tip .zwt-ctxbar.mid i{background:#fbbf24}'
    + '#zusage-wb-tip .zwt-ctxbar.high i{background:#fb923c}'
    + '#zusage-wb-tip .zwt-ctxbar.crit i{background:#f87171}'
    + '#zusage-wb-tip .zwt-models{margin-top:4px}'
    + '#zusage-wb-tip .zwt-models .zwt-row{margin:2px 0}'
    + '#zusage-wb-tip .zwt-models .zwt-k{flex:0 0 154px;overflow:hidden;'
    + 'text-overflow:ellipsis;white-space:nowrap}';

  var cardCss = ''
    + '#zusage-wb-tip .zwt-sub2{font-size:13px;color:rgba(255,255,255,.78);min-width:0;'
    + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#zusage-wb-tip .zwt-chips{display:flex;gap:6px;margin-left:auto}'
    + '#zusage-wb-tip .zwt-chip2{padding:2px 9px;border-radius:999px;'
    + 'border:1px solid rgba(255,255,255,.16);font-size:11px;color:rgba(255,255,255,.6)}'
    + '#zusage-wb-tip .zwt-kpis{display:flex;background:rgba(255,255,255,.05);'
    + 'border-radius:8px;padding:10px 0;margin:2px 0 12px}'
    + '#zusage-wb-tip .zwt-kpic{flex:1 1 0;min-width:0;padding:0 14px}'
    + '#zusage-wb-tip .zwt-kpic+.zwt-kpic{border-left:1px solid rgba(255,255,255,.08)}'
    + '#zusage-wb-tip .zwt-kpl{display:block;font-size:10.5px;color:rgba(255,255,255,.45);'
    + 'margin-bottom:2px}'
    + '#zusage-wb-tip .zwt-kpv{display:block;font-size:22px;font-weight:600;line-height:1.2;'
    + 'color:rgba(255,255,255,.95);font-variant-numeric:tabular-nums;white-space:nowrap;'
    + 'overflow:hidden;text-overflow:ellipsis}'
    + '#zusage-wb-tip .zwt-kpv i{font-style:normal;font-size:11px;font-weight:400;'
    + 'color:rgba(255,255,255,.45);margin-left:4px}'
    + '#zusage-wb-tip .zwt-duo{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0 0 12px}'
    + '#zusage-wb-tip .zwt-duo .zwt-kpv{font-size:17px}'
    + '#zusage-wb-tip .zwt-cache{display:block;margin-top:2px;font-style:normal;'
    + 'font-size:10.5px;color:#3ecf8e}'
    + '#zusage-wb-tip .zwt-dim2{display:block;margin-top:2px;font-size:10.5px;'
    + 'color:rgba(255,255,255,.4)}'
    + '#zusage-wb-tip .zwt-line{margin:0 0 10px;font-size:11.5px;color:rgba(255,255,255,.55);'
    + 'overflow-wrap:anywhere}'
    + '#zusage-wb-tip .zwt-table{margin:2px 0 10px}'
    + '#zusage-wb-tip .zwt-tr{display:grid;grid-template-columns:1.6fr 1fr .8fr .8fr;gap:10px;'
    + 'align-items:baseline;padding:6px 2px;border-top:1px solid rgba(255,255,255,.07)}'
    + '#zusage-wb-tip .zwt-tr span{min-width:0;overflow:hidden;text-overflow:ellipsis;'
    + 'white-space:nowrap}'
    + '#zusage-wb-tip .zwt-tr span:nth-child(n+2){text-align:right;font-variant-numeric:tabular-nums}'
    + '#zusage-wb-tip .zwt-th{border-top:0;padding:2px;font-size:10.5px;'
    + 'color:rgba(255,255,255,.42)}'
    + '#zusage-wb-tip .zwt-tools .zwt-tr{grid-template-columns:1.6fr .8fr 1fr .6fr}'
    + '#zusage-wb-tip .zwt-foot{margin-top:10px;padding-top:8px;'
    + 'border-top:1px solid rgba(255,255,255,.08);font-size:10.5px;'
    + 'color:rgba(255,255,255,.42);line-height:1.6}'
    + '#zusage-wb-tip .zwt-foot b{font-weight:500;color:rgba(255,255,255,.55)}'
    + '#zusage-wb-tip .zwt-fnote{margin-top:3px;color:rgba(255,255,255,.36)}'
    + '#zusage-wb-tip.zwt-mid{width:min(560px,calc(100vw - 24px));max-width:none}'
    + '#zusage-wb-tip.zwt-w640{width:min(640px,calc(100vw - 24px));max-width:none}';

  var tipStyle = document.createElement('style');
  tipStyle.id = 'zusage-wb-tip-style';
  tipStyle.textContent = tipCss + cardCss;
  document.head.appendChild(tipStyle);

  var tipEl = document.createElement('div');
  tipEl.id = 'zusage-wb-tip';
  document.body.appendChild(tipEl);

  /* ---------- 设置面板（⚙）：显示项 / 排布 / 数字单位，持久化到 localStorage ----------
     对齐 ZCode 状态条的 ⚙ 设置入口；这里只保留对 WorkBuddy 宿主真正生效的项
     （宿主没有 asar 注入链，ZCode 那些引擎补丁类开关搬过来没有落点）。 */
  var SET_ID = ID + '-set';
  var setCss = ''
    + '#' + SET_ID + '{position:fixed;z-index:2147483600;display:none;width:min(392px,calc(100vw - 24px));'
    + 'max-height:min(76vh,620px);overflow:auto;padding:12px 14px 11px;border-radius:12px;'
    + 'background:#1b1b1f;border:1px solid rgba(255,255,255,.12);box-shadow:0 14px 40px rgba(0,0,0,.55);'
    + 'color:rgba(255,255,255,.72);font:12px/1.55 "Segoe UI",system-ui,sans-serif;'
    + 'text-align:left;white-space:normal}'
    + '#' + SET_ID + ' .zs-head{display:flex;align-items:center;gap:8px}'
    + '#' + SET_ID + ' .zs-title{font-size:13.5px;font-weight:600;color:rgba(255,255,255,.94)}'
    + '#' + SET_ID + ' .zs-ver{margin-left:auto;font-size:10px;color:rgba(255,255,255,.38)}'
    + '#' + SET_ID + ' .zs-x{width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;'
    + 'color:rgba(255,255,255,.55);cursor:pointer;font-size:12px;line-height:1}'
    + '#' + SET_ID + ' .zs-x:hover{background:rgba(255,255,255,.1);color:#fff}'
    + '#' + SET_ID + ' .zs-cap{margin:11px 0 3px;font-size:10px;letter-spacing:.08em;color:rgba(255,255,255,.38)}'
    + '#' + SET_ID + ' .zs-row{display:flex;align-items:flex-start;gap:8px;padding:3px 5px;border-radius:6px;cursor:pointer}'
    + '#' + SET_ID + ' .zs-row:hover{background:rgba(255,255,255,.05)}'
    + '#' + SET_ID + ' .zs-row input{margin:3px 0 0;flex:0 0 auto;accent-color:#4ade80;cursor:pointer}'
    + '#' + SET_ID + ' .zs-txt{min-width:0}'
    + '#' + SET_ID + ' .zs-l{display:block;font-size:12px;color:rgba(255,255,255,.86)}'
    + '#' + SET_ID + ' .zs-d{display:block;font-size:10.5px;line-height:1.45;color:rgba(255,255,255,.4)}'
    + '#' + SET_ID + ' .zs-seg{display:flex;gap:6px}'
    + '#' + SET_ID + ' .zs-seg label{flex:1 1 0;display:flex;align-items:center;justify-content:center;'
    + 'padding:5px 4px;border-radius:7px;border:1px solid rgba(255,255,255,.14);cursor:pointer;font-size:11.5px}'
    + '#' + SET_ID + ' .zs-seg label:hover{background:rgba(255,255,255,.06)}'
    + '#' + SET_ID + ' .zs-seg input{display:none}'
    + '#' + SET_ID + ' .zs-seg label.on{background:rgba(96,165,250,.16);border-color:rgba(96,165,250,.55);color:#dbeafe}'
    + '#' + SET_ID + ' .zs-note{margin-top:11px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08);'
    + 'font-size:10.5px;line-height:1.55;color:rgba(255,255,255,.4)}'
    + '#' + SET_ID + ' .zs-act{display:flex;gap:8px;margin-top:9px}'
    + '#' + SET_ID + ' .zs-btn{flex:1 1 0;padding:5px 8px;border-radius:7px;cursor:pointer;font-family:inherit;'
    + 'font-size:11.5px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);'
    + 'color:rgba(255,255,255,.78)}'
    + '#' + SET_ID + ' .zs-btn:hover{background:rgba(255,255,255,.12);color:#fff}';

  var setStyle = document.createElement('style');
  setStyle.id = ID + '-set-style';
  setStyle.textContent = setCss;
  document.head.appendChild(setStyle);

  var setEl = document.createElement('div');
  setEl.id = ID + '-set';
  setEl.setAttribute('role', 'dialog');
  setEl.setAttribute('aria-label', '状态条设置');
  document.body.appendChild(setEl);

  function buildSet(){
    var rows = '';
    for (var i = 0; i < SHOW_ITEMS.length; i++) {
      var it = SHOW_ITEMS[i];
      rows += '<label class="zs-row"><input type="checkbox" data-k="' + it.k + '"'
        + (prefs.show[it.k] !== false ? ' checked' : '') + '>'
        + '<span class="zs-txt"><span class="zs-l">' + esc(it.label) + '</span>'
        + '<span class="zs-d">' + esc(it.desc) + '</span></span></label>';
    }
    var justs = [['between', '均分'], ['start', '居左'], ['end', '居右']];
    var segs = '';
    for (var j = 0; j < justs.length; j++) {
      var act = prefs.just === justs[j][0];
      segs += '<label class="' + (act ? 'on' : '') + '">'
        + '<input type="radio" name="zs-just" value="' + justs[j][0] + '"' + (act ? ' checked' : '') + '>'
        + '<span>' + justs[j][1] + '</span></label>';
    }
    setEl.innerHTML =
        '<div class="zs-head"><span class="zs-title">状态条设置</span>'
      + '<span class="zs-ver">' + esc(VER) + '</span>'
      + '<button type="button" class="zs-x" aria-label="关闭设置">✕</button></div>'
      + '<div class="zs-cap">状态条显示</div>' + rows
      + '<div class="zs-cap">排布</div>'
      + '<div class="zs-seg" role="radiogroup" aria-label="状态条排布">' + segs + '</div>'
      + '<div class="zs-cap">通用</div>'
      + '<label class="zs-row"><input type="checkbox" data-k="cnNum"' + (prefs.cnNum ? ' checked' : '') + '>'
      + '<span class="zs-txt"><span class="zs-l">中文单位（万/亿）</span>'
      + '<span class="zs-d">token 数量按万/亿显示，默认 K/M/B</span></span></label>'
      + '<div class="zs-note">数据源：WorkBuddy 本地库（只读）+ 会话正文的逐次调用用量；'
      + '费用按价表牌价估算，不是账单。设置只存本机 localStorage，不上传。</div>'
      + '<div class="zs-act"><button type="button" class="zs-btn" data-act="reset">恢复默认</button>'
      + '<button type="button" class="zs-btn" data-act="close">关闭</button></div>';
  }

  /* 隐藏分段后，贴左/贴右的目标会变，所以按当前可见项重打 .first/.end，而不是写死选择器。 */
  function applyPrefs(){
    var items = bar.querySelectorAll('.it');
    var vis = [];
    for (var i = 0; i < items.length; i++) {
      var el = items[i], k = el.classList[1];
      var on = k === 'st' ? true : prefs.show[k] !== false;
      el.style.display = on ? '' : 'none';
      el.classList.remove('first', 'end');
      if (on) vis.push(el);
    }
    if (vis.length) { vis[0].classList.add('first'); vis[vis.length - 1].classList.add('end'); }
    bar.classList.toggle('jstart', prefs.just === 'start');
    bar.classList.toggle('jend', prefs.just === 'end');
  }

  var setOpen = false;
  function placeSet(){
    var r = bar.getBoundingClientRect();
    var w = setEl.offsetWidth || 380, h = setEl.offsetHeight || 340;
    var left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    var top = r.top - h - 8;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
    setEl.style.left = Math.round(left) + 'px';
    setEl.style.top = Math.round(Math.max(8, top)) + 'px';
  }
  function openSet(){
    hideTip();
    pop.style.display = 'none';
    buildSet();
    setEl.style.display = 'block';
    setOpen = true;
    bar.querySelector('.set').classList.add('on');
    placeSet();
  }
  function closeSet(){
    setEl.style.display = 'none';
    setOpen = false;
    bar.querySelector('.set').classList.remove('on');
  }
  function toggleSet(ev){
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    if (setOpen) closeSet(); else openSet();
  }
  var setBtn = bar.querySelector('.set');
  if (window.PointerEvent) setBtn.addEventListener('pointerdown', toggleSet, true);
  else setBtn.addEventListener('click', toggleSet);

  setEl.addEventListener('change', function(ev){
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var isJust = t.getAttribute('name') === 'zs-just';
    if (isJust) {
      prefs.just = t.value;
    } else {
      var k = t.getAttribute('data-k');
      if (!k) return;
      if (k === 'cnNum') prefs.cnNum = !!t.checked;
      else prefs.show[k] = !!t.checked;
    }
    savePrefs();
    applyPrefs();
    if (isJust) buildSet();   // 刷新选中态（重建前已把值写进 prefs）
    if (window.__zusageWB_update) window.__zusageWB_update(lastPayload);
  });
  setEl.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('.zs-x') || t.closest('[data-act="close"]')) { closeSet(); return; }
    if (t.closest('[data-act="reset"]')) {
      prefs = { show: {}, just: 'between', cnNum: false };
      savePrefs();
      applyPrefs();
      buildSet();
      if (window.__zusageWB_update) window.__zusageWB_update(lastPayload);
    }
  });
  ['pointerdown', 'click'].forEach(function(type){
    document.addEventListener(type, function(ev){
      if (!setOpen) return;
      var t = ev.target;
      if (setEl.contains(t)) return;
      if (t && t.closest && t.closest('.set')) return;   // 点按钮交给 toggleSet
      closeSet();
    }, true);
  });
  document.addEventListener('keydown', function(ev){
    if (!setOpen) return;
    if (ev.key === 'Escape') { ev.stopPropagation(); closeSet(); }
  }, true);
  window.addEventListener('resize', function(){ if (setOpen) placeSet(); });

  applyPrefs();

  function tHead(title, scope) {
    return '<div class="zwt-head"><span class="zwt-title">' + esc(title) + '</span>'
      + (scope ? '<span class="zwt-scope">' + esc(scope) + '</span>' : '') + '</div>';
  }
  function tRow(k, v) {
    return '<div class="zwt-row"><span class="zwt-k">' + esc(k) + '</span>'
      + '<span class="zwt-v">' + v + '</span></div>';
  }
  function tNote(text) { return '<div class="zwt-note">' + text + '</div>'; }
  function tSep() { return '<div class="zwt-sep"></div>'; }
  function hitPct(cacheRead, input) {
    return input > 0 ? Math.round((Number(cacheRead) || 0) / input * 100) : 0;
  }

  function niceScale(mx) {
    /* 4 格以内、且尽量少留白：217 → 100/300（而不是 400）；154 → 50/200，与参考图一致 */
    var cands = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
    var target = Math.max(1, Number(mx) || 1);
    for (var i = 0; i < cands.length; i++) {
      var n = Math.ceil(target / cands[i]);
      if (n <= 4) return { step: cands[i], top: cands[i] * n, n: n };
    }
    return { step: 1000, top: 4000, n: 4 };
  }
  function relSpan(ms) {
    var sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 120) return sec + 's';
    var m = Math.floor(sec / 60), r = sec % 60;
    return m + 'm' + (r ? ('0' + r).slice(-2) + 's' : '');
  }
  function dateOf(ts) {
    var d = new Date(Number(ts) || 0);
    if (!ts || isNaN(d.getTime())) return '--';
    return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  var STATUS_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">'
    + '<circle cx="8" cy="8" r="6.3"/><path d="M5.3 8.1l1.8 1.8 3.6-3.8"/></svg>';

  function speedTip(d) {
    var pts = (d.speedPoints || []).slice(-10);
    var avg = Number(d.tps) || 0;
    var bd = tband(avg);
    var vals = pts.map(function (p) { return Number(p.tps) || 0; });
    var mx = vals.length ? Math.max.apply(null, vals) : 0;
    var mn = vals.length ? Math.min.apply(null, vals) : 0;
    var lastV = vals.length ? vals[vals.length - 1] : 0;
    var scale = niceScale(mx || 10);
    var step = scale.step, yMax = scale.top, nTick = scale.n;

    var bars = '', times = '';
    // 同一分钟的连续段用「相对秒」标注，否则 8 个柱子全是一个时间点
    var span = pts.length > 1 ? (Number(pts[pts.length - 1].ts) - Number(pts[0].ts)) : 0;
    var rel = span > 0 && span <= 600000;
    for (var i = 0; i < pts.length; i++) {
      var v = Number(pts[i].tps) || 0;
      var b = tband(v);
      var h = Math.max(2, Math.round(v / yMax * 146));
      bars += '<span class="zwt-col"><b>' + v.toFixed(1) + '</b>'
        + '<i class="zwt-bar' + (b ? ' ' + b.cls : '') + '" style="height:' + h + 'px"></i></span>';
      times += '<span><i>' + dateOf(pts[i].ts) + '</i>'
        + (rel ? clockSec(pts[i].ts) : clockOf(pts[i].ts)) + '</span>';
    }

    var axisHtml = '', gridHtml = '';
    for (var t = 0; t <= nTick; t++) {
      var pos = Math.round(t / nTick * 100);
      axisHtml += '<span style="bottom:' + pos + '%' + (t === nTick ? ';transform:none' : '') + '">'
        + Math.round(step * t) + '</span>';
      if (t > 0) gridHtml += '<div class="zwt-grid" style="bottom:' + pos + '%"></div>';
    }
    var chart = pts.length
      ? '<div class="zwt-chart"><div class="zwt-chead"><b>最近 ' + pts.length + ' 段</b>'
        + '<span>按完成顺序 · 从旧到新</span><span class="zwt-unitr">单位：t/s</span></div>'
        + '<div class="zwt-plot"><div class="zwt-axis">' + axisHtml + '</div>'
        + '<div class="zwt-grid" style="bottom:0"></div>' + gridHtml
        + '<div class="zwt-cols">' + bars + '</div></div>'
        + '<div class="zwt-times">' + times + '</div></div>'
      : '<div class="zwt-chart"><div class="zwt-note" style="border:0;padding:0">'
        + '还没有可用的速度样本（窗口 &lt; 200ms 视为无效）。</div></div>';

    var stats = pts.length
      ? '<div class="zwt-stats">'
        + '<span class="zwt-stat"><i>峰值</i><b' + (tband(mx) ? ' class="' + tband(mx).cls + '"' : '') + '>' + mx.toFixed(1) + '</b></span>'
        + '<span class="zwt-stat"><i>最低</i><b' + (tband(mn) ? ' class="' + tband(mn).cls + '"' : '') + '>' + mn.toFixed(1) + '</b></span>'
        + '<span class="zwt-stat"><i>最新</i><b' + (tband(lastV) ? ' class="' + tband(lastV).cls + '"' : '') + '>' + lastV.toFixed(1) + '</b></span>'
        + '</div>'
      : '';

    var legend = '<div class="zwt-legend"><em>颜色对照</em>';
    for (var j = TB.length - 1; j >= 0; j--) {
      legend += '<span class="' + TB[j].cls + '"><i></i>' + TB[j].label
        + (TB[j].cls === 'ultra' ? ' <b>Ultra</b>' : '') + '</span>';
    }
    legend += '</div>';

    var basis = '<div class="zwt-basis"><h4>统计口径</h4>'
      + '<p>输出（含思考）÷ 生成耗时</p>'
      + '<small>最近 ' + (pts.length || 0) + ' 段：每个已完成有效分段的真实速度，按完成顺序从旧到新；'
      + '工具等待不计，不含子代理。</small>'
      + '<small>时间范围 ' + (pts.length ? stampOf(pts[0].ts) + ' — ' + stampOf(pts[pts.length - 1].ts) : '—')
      + '</small></div>';

    return tHead('生成速度', '会话平均') +
      '<div class="zwt-speed"><div class="zwt-left">'
      + '<div class="zwt-status' + (d.active ? ' active' : '') + '">' + STATUS_ICON
      + (d.active ? '生成中' : '生成完成') + '</div>'
      + '<div class="zwt-rd">当前读数</div>'
      + '<div class="zwt-big"><small>均</small><b>' + (avg ? avg.toFixed(1) : '—') + '</b><i>t/s</i></div>'
      + (bd ? '<span class="zwt-band ' + bd.cls + '">' + bd.zh + ' · ' + bd.label + ' t/s</span>' : '')
      + '<div class="zwt-sub">会话加权平均</div>'
      + stats + '</div>' + chart + '</div>' + legend + basis;
  }

  /* ---------- 卡片通用块（对齐 ZCode 的三段式：KPI 格 / 投入产出 / 表格） ---------- */
  function chips(arr) {
    if (!arr || !arr.length) return '';
    return '<div class="zwt-chips">' + arr.map(function (c) {
      return '<span class="zwt-chip2">' + esc(c) + '</span>';
    }).join('') + '</div>';
  }
  function tHead3(title, sub, chipArr) {
    return '<div class="zwt-head"><span class="zwt-title">' + esc(title) + '</span>'
      + (sub ? '<span class="zwt-sub2">' + esc(sub) + '</span>' : '')
      + chips(chipArr) + '</div>';
  }
  function kpis(items) {
    /* items: [label, value, unit?, valueCls?] */
    return '<div class="zwt-kpis">' + items.map(function (it) {
      return '<div class="zwt-kpic"><span class="zwt-kpl">' + esc(it[0]) + '</span>'
        + '<span class="zwt-kpv' + (it[3] ? ' ' + it[3] : '') + '">' + it[1]
        + (it[2] ? '<i>' + esc(it[2]) + '</i>' : '') + '</span></div>';
    }).join('') + '</div>';
  }
  function duo(inputVal, cachePct, outputVal, outNote) {
    return '<div class="zwt-duo">'
      + '<div><span class="zwt-kpl">输入</span><span class="zwt-kpv">' + inputVal + '</span>'
      + '<em class="zwt-cache">缓存命中率 ' + cachePct + '%</em></div>'
      + '<div><span class="zwt-kpl">输出</span><span class="zwt-kpv">' + outputVal + '</span>'
      + (outNote ? '<span class="zwt-dim2">' + outNote + '</span>' : '') + '</div></div>';
  }
  function modelCost(m) {
    var v = (m && m.cost_usd != null) ? m.cost_usd : (m && m.usd != null ? m.usd : null);
    return (m && m.priced && v != null) ? money(v) : '—';
  }
  function modelTable(models) {
    var rows = '';
    (models || []).forEach(function (m) {
      var total = (m.total != null) ? m.total : ((Number(m.input) || 0) + (Number(m.output) || 0));
      rows += '<div class="zwt-tr"><span>' + esc(m.model || '—') + '</span>'
        + '<span>' + fmt(total) + '</span><span>' + num(m.requests) + '</span>'
        + '<span>' + modelCost(m) + '</span></div>';
    });
    if (!rows) return '';
    return '<div class="zwt-table"><div class="zwt-tr zwt-th"><span>模型</span>'
      + '<span>Token 用量</span><span>请求次数</span><span>预估费用</span></div>' + rows + '</div>';
  }
  function foot(range, note) {
    return '<div class="zwt-foot">'
      + (range ? '<div><b>时间范围</b> ' + range + '</div>' : '')
      + (note ? '<div class="zwt-fnote">' + note + '</div>' : '') + '</div>';
  }
  function secs(ms) {
    var n = Number(ms) || 0;
    if (n <= 0) return '—';
    if (n < 1000) return '<1s';
    return (n / 1000).toFixed(1) + 's';
  }
  function rangeOf(a, b) { return a ? stampOf(a) + ' — ' + stampOf(b || a) : '—'; }
  function dur(ms) {
    /* 工具耗时可能到小时级（长跑命令），用 2h20m / 12m34s 更好读；分秒以下仍显示秒 */
    var n = Number(ms) || 0;
    if (n <= 0) return '—';
    var sec = n / 1000;
    if (sec < 60) return sec < 1 ? '<1s' : sec.toFixed(1) + 's';
    var m = Math.floor(sec / 60), rs = Math.round(sec % 60);
    if (m < 60) return m + 'm' + (rs ? ('0' + rs).slice(-2) + 's' : '');
    var h = Math.floor(m / 60), rm = m % 60;
    return h + 'h' + (rm ? rm + 'm' : '');
  }

  function turnTip(d) {
    var t = d.turnDetail || {};
    var cache = hitPct(t.cacheRead, t.input);
    return tHead3('本轮', '', [num(t.requests) + ' 次请求'])
      + kpis([
        ['总用量', fmt(t.total), 'tokens'],
        ['输出速度', t.tps ? t.tps.toFixed(1) : '—', 't/s'],
        ['预估费用', moneyOr(t.cost)]
      ])
      + duo(fmt(t.input), cache, fmt(t.output),
            t.reasoning ? '含思考 ' + fmt(t.reasoning) : '')
      + kpis([
        ['平均耗时', secs(t.avgDurationMs)],
        ['本轮生成耗时', secs(t.durationMs)],
        ['工具调用', num(t.toolCalls), '次']
      ])
      + (t.model ? '<div class="zwt-line">' + esc(t.model) + '　' + fmt(t.total)
        + ' token · ' + num(t.requests) + ' 次 · ' + moneyOr(t.cost) + '</div>' : '')
      + foot(rangeOf(t.started, t.ended),
             '速度 = Σ有效段输出 ÷ Σ有效段生成耗时，工具等待不计；费用按牌价估算，非账单。');
  }

  function sessionTip(d) {
    var s = d.sessionDetail || {};
    return tHead3('会话', s.title || '', ['全部请求'])
      + kpis([
        ['总用量', fmt(s.total), 'tokens'],
        ['请求次数', num(s.requests)],
        ['预估费用', moneyOr(s.cost)]
      ])
      + duo(fmt(s.input), hitPct(s.cacheRead, s.input), fmt(s.output),
            s.reasoning ? '含思考 ' + fmt(s.reasoning) : '')
      + '<div class="zwt-line">' + num(s.turns) + ' 轮对话 · 工具调用 '
      + num(s.toolCalls) + ' 次' + (s.toolErrors ? '（错误 ' + s.toolErrors + '）' : '')
      + (s.tps ? ' · 均速 ' + s.tps + ' t/s' : '') + '</div>'
      + modelTable(s.models)
      + foot(rangeOf(s.started, s.lastAt),
             '请求 = 模型调用次数，轮 = 用户消息条数；速度按响应窗口近似；费用按牌价估算。');
  }

  function toolsTip(d) {
    var list = d.toolList || [];
    var rows = '';
    for (var i = 0; i < list.length; i++) {
      rows += '<div class="zwt-tr"><span>' + esc(list[i].name) + '</span>'
        + '<span>' + num(list[i].count) + '</span>'
        + '<span>' + dur(list[i].ms) + '</span>'
        + '<span' + (list[i].errors ? ' style="color:#f87171"' : '') + '>' + num(list[i].errors) + '</span></div>';
    }
    return tHead3('工具调用', '', [num(d.toolCalls) + ' 次'])
      + kpis([
        ['调用总数', num(d.toolCalls), '次'],
        ['错误', num(d.toolErrors), '次', d.toolErrors ? 'hot' : '']
      ])
      + (rows
        ? '<div class="zwt-table zwt-tools"><div class="zwt-tr zwt-th"><span>工具</span>'
          + '<span>调用次数</span><span>累计耗时</span><span>错误</span></div>' + rows + '</div>'
        : '<div class="zwt-line">这个会话还没有工具调用。</div>')
      + foot('', '按调用次数排序；耗时 = 调用记录 → 结果记录；错误按 callId 归属。');
  }

  function todayTip(d) {
    var t = d.todayDetail || {};
    return tHead3('今日合计', '', ['今天所有会话'])
      + kpis([
        ['总用量', fmt(t.total), 'tokens'],
        ['请求次数', num(t.requests)],
        ['预估费用', moneyOr(t.cost)]
      ])
      + kpis([
        ['输入用量', fmt(t.input)],
        ['输出用量', fmt(t.output)],
        ['重试次数', '—']
      ])
      + '<div class="zwt-line"><em class="zwt-cache" style="display:inline">缓存命中率 '
      + hitPct(t.cacheRead, t.input) + '%</em></div>'
      + '<div class="zwt-line">' + num(t.sessions) + ' 个会话 · credit '
      + (Number(t.credits) || 0).toFixed(2)
      + (t.reasoning ? ' · 思考 ' + fmt(t.reasoning) : '') + '</div>'
      + foot(rangeOf(t.firstAt, t.lastAt),
             '按请求时间归属（不是会话创建日）；credit 是宿主计费口径，不是账单；'
             + 'WorkBuddy 不记录重试次数（显示 —）。'
             + (d.costPartial ? ' 部分模型未收录价表，费用只含已定价部分。' : ''));
  }

  function ctxTip(d) {
    var pct = Number(d.pct) || 0;
    var cls = pct >= 90 ? 'crit' : pct >= 80 ? 'high' : pct >= 50 ? 'mid' : '';
    return tHead3('上下文占用', '', [pct.toFixed(1) + '%'])
      + '<div class="zwt-ctxbar ' + cls + '"><i style="width:' + Math.min(100, pct) + '%"></i></div>'
      + kpis([
        ['已用', fmt(d.ctx), 'tokens'],
        ['窗口', fmt(d.cw), 'tokens'],
        ['剩余', fmt(Math.max(0, Number(d.cw) - Number(d.ctx))), 'tokens']
      ])
      + foot('', '含系统提示、历史消息与工具结果；窗口取 session_usage.size，缺省回退会话配置。'
        + (d.contextAuto ? ' 当前为回退值。' : ''));
  }

  function projTip(d) {
    var p = d.projectDetail || {};
    return tHead3('项目累计', d.cwd || '', ['全部请求'])
      + kpis([
        ['总用量', fmt(p.total), 'tokens'],
        ['请求次数', num(p.requests)],
        ['预估费用', moneyOr(p.cost)]
      ])
      + duo(fmt(p.input || 0), hitPct(p.cacheRead || 0, p.input || 0), fmt(p.output || 0), '')
      + '<div class="zwt-line">' + num(p.sessions) + ' 会话 · ' + num(p.turns)
      + ' 轮 · 工具 ' + num(p.toolCalls) + ' 次'
      + (p.toolErrors ? '（错误 ' + p.toolErrors + '）' : '') + '</div>'
      + modelTable(p.models)
      + foot(rangeOf(p.firstAt, p.lastAt),
             '同一工作目录下所有会话的累计（含非当前会话）；费用按牌价估算，非账单。');
  }

  function sourceTip(d) {
    return tHead('数据源', d.host || '')
      + tRow('状态', d.ok ? '<span style="color:#4ade80">本地库可读</span>'
        : '<span style="color:#fbbf24">未找到本地库</span>')
      + tRow('数据库', esc(d.dbPath || '—'))
      + tRow('会话', esc(d.title || '—') + (d.active ? ' · 进行中' : ''))
      + tRow('更新', lastAt ? new Date(lastAt).toLocaleTimeString() : '—')
      + tNote('只读：不写库、不上传；token 与费用来自会话正文的逐次调用记录。');
  }

  var TIP_RENDER = {
    st: sourceTip, spd: speedTip, turn: turnTip, sess: sessionTip,
    tool: toolsTip, today: todayTip, ctx: ctxTip, proj: projTip
  };
  var tipKind = '';
  var tipAnchor = null;
  var tipTimer = 0;

  function placeTip(anchor) {
    if (!anchor || !anchor.getBoundingClientRect) return;
    var r = anchor.getBoundingClientRect();
    var w = tipEl.offsetWidth || 320, h = tipEl.offsetHeight || 200;
    var left = Math.round(r.left + r.width / 2 - w / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    var top = Math.round(r.top - h - 10);
    if (top < 8) top = Math.round(Math.min(window.innerHeight - h - 8, r.bottom + 10));
    tipEl.style.left = left + 'px';
    tipEl.style.top = Math.max(8, top) + 'px';
  }
  function showTip(kind, anchor) {
    var build = TIP_RENDER[kind];
    if (!build) return;
    tipKind = kind;
    tipAnchor = anchor;
    tipEl.className = kind === 'spd' ? 'zwt-wide'
      : (kind === 'turn' || kind === 'proj') ? 'zwt-w640' : 'zwt-mid';
    tipEl.innerHTML = build(lastPayload);
    tipEl.style.display = 'block';
    placeTip(anchor);
  }
  function hideTip() {
    tipEl.style.display = 'none';
    tipKind = '';
    tipAnchor = null;
  }
  function laterHide() {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, 160);
  }
  Array.prototype.forEach.call(bar.querySelectorAll('.it'), function (el) {
    var kind = el.classList[1];
    el.addEventListener('pointerenter', function () {
      clearTimeout(tipTimer);
      showTip(kind, el);
    });
    el.addEventListener('pointerleave', laterHide);
  });
  tipEl.addEventListener('pointerenter', function () { clearTimeout(tipTimer); });
  tipEl.addEventListener('pointerleave', laterHide);

  function mount(){
    var card = document.querySelector('.cr-input-container');
    if (card) {
      /* 只在被宿主摘掉时贴回；顺序交给 CSS 的 flex order:9999，不反复搬节点
         （来回 appendChild 会打断悬停、也容易和 React 的插入互相打架）。 */
      if (bar.parentElement !== card) {
        bar.classList.remove('fallback');
        card.appendChild(bar);
      }
      return true;
    }
    if (bar.parentElement !== document.body) {
      bar.classList.add('fallback');
      document.body.appendChild(bar);
    }
    return false;
  }

  /* 宿主 React 重渲染会移除非它创建的节点（bar 就在其中）：只靠 2.5s 数据 tick
     贴回，中间会有一段可见空窗（闪烁）。用 MutationObserver 在下一帧补回。 */
  var moRaf = 0;
  var mo = new MutationObserver(function(){
    if (moRaf) return;
    moRaf = requestAnimationFrame(function(){ moRaf = 0; mount(); });
  });
  try { mo.observe(document.body, {childList: true, subtree: true}); } catch (e) { /* 老内核 */ }
  mount();

  setInterval(function(){
    var stale = !lastAt || (Date.now() - lastAt > 12000);
    bar.classList.toggle('stale', stale);
    if (stale) bar.title = 'WorkBuddy 用量：数据已停止刷新（注入器未在运行）';
  }, 2000);

  window.__zusageWB_update = function(d){
    d = d || {};
    lastPayload = d;
    lastAt = Date.now();
    fxRate = Number(d.fxRate) || 0;
    mount();
    bar.className = band(Number(d.pct) || 0);
    applyPrefs();   // className 被重置，排布模式与分段显隐按偏好重贴
    bar.querySelector('.st').classList.toggle('bad', !d.ok);
    bar.querySelector('.sts').textContent = d.ok ? '本地库' : '未找到库';
    bar.querySelector('.spdv').textContent = d.tps ? d.tps.toFixed(1) : '--';
    bar.querySelector('.spd').title = d.tps
      ? '会话加权平均 ' + d.tps + ' t/s' + (d.lastTps ? ' · 最近一段 ' + d.lastTps + ' t/s' : '')
      : '暂无有效速度样本';
    bar.querySelector('.turnv').textContent = fmt(d.turnTotal);
    bar.querySelector('.turnr').textContent = d.turnRequests ? num(d.turnRequests) + '次' : '';
    bar.querySelector('.turn').title = '本轮 tokens / 请求次数';
    bar.querySelector('.sessv').textContent = num(d.turns) + '轮';
    bar.querySelector('.sessr').textContent = num(d.requests) + '次';
    bar.querySelector('.sess').title = '会话累计轮次 / 请求';
    bar.querySelector('.toolv').textContent = num(d.toolCalls);
    bar.querySelector('.toolerr').textContent = d.toolErrors ? '·' + d.toolErrors : '';
    bar.querySelector('.tool').title = '工具调用次数' + (d.toolErrors ? '（错误 ' + d.toolErrors + '）' : '');
    bar.querySelector('.todayv').textContent = fmt(d.todayTotal);
    bar.querySelector('.todayr').textContent = d.todayRequests ? num(d.todayRequests) + '次' : '';
    bar.querySelector('.today').title = '今日全部会话 tokens / 请求';
    bar.querySelector('.pct').textContent = (Number(d.pct) || 0).toFixed(1) + '%';
    bar.querySelector('.ctx').title = '上下文 ' + fmt(d.ctx) + ' / ' + fmt(d.cw) + '（窗口）';
    bar.querySelector('.projv').textContent = d.projTotal ? fmt(d.projTotal) : '--';
    bar.querySelector('.proj').title = '项目累计 ' + fmt(d.projTotal) + ' tokens · '
      + num(d.projSessions) + ' 个会话';
    bar.title = 'WorkBuddy 用量（只读本地库）';
    if (tipKind && tipEl.style.display === 'block') {
      var build = TIP_RENDER[tipKind];
      if (build) { tipEl.innerHTML = build(d); placeTip(tipAnchor); }
    }
  };
  window.__zusageWB_destroy = function(){
    if (mo) { try { mo.disconnect(); } catch (e) {} }
    if (moRaf) { try { cancelAnimationFrame(moRaf); } catch (e) {} }
    var n = document.getElementById(ID);
    if (n) n.remove();
    if (pop && pop.parentElement) pop.remove();
    if (tipEl && tipEl.parentElement) tipEl.remove();
    if (tipStyle && tipStyle.parentElement) tipStyle.remove();
    if (setEl && setEl.parentElement) setEl.remove();
    if (setStyle && setStyle.parentElement) setStyle.remove();
    var s2 = document.getElementById(ID + '-style');
    if (s2) s2.remove();
    delete window.__zusageWB_update;
    delete window.__zusageWB_destroy;
    delete window.__zusageWB_version;
  };
  window.__zusageWB_version = VER;
  return 'injected';
})()`;

async function inject(cdp) {
  const res = await cdp.call('Runtime.evaluate', {
    expression: PAGE_SCRIPT, returnByValue: true, awaitPromise: false,
  });
  return res && res.result && res.result.value;
}

async function push(cdp, payload) {
  await cdp.call('Runtime.evaluate', {
    expression: 'window.__zusageWB_update && window.__zusageWB_update(' + JSON.stringify(payload) + ')',
    returnByValue: false,
  });
}

/* ---------- 主循环 ---------- */

async function main() {
  if (typeof WebSocket !== 'function') {
    log('node 缺少全局 WebSocket（需 22+），退出');
    process.exit(3);
  }
  const holder = liveLock();
  if (holder) {
    log('已有实例在跑 pid=' + holder.pid + '，退出');
    return;
  }
  touchLock({ port: PORT });
  const py = startPython();
  let retry = 0;
  let cdp = null;
  let timer = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    if (cdp) cdp.close();
    if (py) py.stop();
    dropLock();
  };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  async function tick() {
    try { touchLock({ port: PORT }); } catch (e) { /* 心跳写失败不影响注入 */ }
    try {
      if (!cdp || !cdp.open) {
        const target = await listTargets();
        if (!target) throw new Error('未找到 WorkBuddy 页面 target');
        cdp = await connect(target.webSocketDebuggerUrl);
        await cdp.call('Runtime.enable');
        retry = 0;
        log('已连接页面：' + (target.title || target.url || ''));
      }
      const injected = await inject(cdp);
      const line = py ? await py.query() : null;
      const payload = line ? toPayload(JSON.parse(line)) : null;
      if (payload) await push(cdp, payload);
      if (ONCE) {
        log('注入结果：' + injected + '，数据：' + (payload ? payload.pct.toFixed(1) + '% / ' + payload.credits + 'cr' : '无') + '（--once，退出）');
        stop();
        process.exit(0);
      }
    } catch (e) {
      retry += 1;
      log('第 ' + retry + ' 次失败：' + (e && e.message ? e.message : e));
      if (cdp) { try { cdp.close(); } catch (err) { /* ignore */ } }
      cdp = null;
      if (retry >= MAX_RETRY) {
        log('连续失败 ' + retry + ' 次，退出（客户端可能未开启调试端口）');
        stop();
        process.exit(4);
      }
    }
  }

  await tick();
  if (ONCE) return;
  timer = setInterval(() => { tick(); }, Math.max(1000, INTERVAL));
}

// 未捕获的 Promise 拒绝在 Node 22 默认会杀进程：浮层宁可不更新，也不能被一次异常带走
process.on('unhandledRejection', (e) => log('unhandled: ' + (e && e.message ? e.message : e)));

main().catch((e) => {
  log('fatal: ' + (e && e.message ? e.message : e));
  dropLock();
  process.exit(1);
});
