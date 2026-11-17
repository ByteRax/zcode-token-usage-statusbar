const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', '..', 'overlay.js'), 'utf8');

/* 份额夹具：整 IIFE 执行 + instances 接缝（overlay-ctxbtn 同款夹具）。
 * 夹具：输入卡片 group/toolbar 工具行放 wrapper span > button[data-testid=chat-context-usage-trigger]，
 * 推带 quota 字段与 recent[].last.provider_id 的 payload，断言 chip 前插/门控/档位/幂等/兜回/还原/tooltip。 */
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
    this.style.setProperty = (k, v) => { this.style[k] = v; };
    this.style.getPropertyValue = k => this.style[k] || '';
    this.listeners = new Map(); this.queries = new Map(); this.classes = new Set();
    this.classList = { contains: k => this.classes.has(k), add: k => this.classes.add(k), remove: k => this.classes.delete(k),
      toggle: (k, on) => { if (on) this.classes.add(k); else this.classes.delete(k); } };
    this.textContent = ''; this.innerHTML = ''; this._className = ''; this.isConnected = true;
  }
  set className(v) { this._className = String(v); this.classes.clear(); this._className.split(/\s+/).filter(Boolean).forEach(c => this.classes.add(c)); }
  get className() { return this._className; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return this.parentElement.children[i + 1] || null;
  }
  setAttribute(k, v) { this.dataset[k] = String(v); }
  removeAttribute(k) { delete this.dataset[k]; }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  appendChild(el) { this.children.push(el); el.parentElement = this; el.isConnected = true; return el; }
  insertBefore(el, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    if (el.parentElement) el.remove();
    const idx = this.children.indexOf(ref);
    this.children.splice(idx, 0, el); el.parentElement = this; el.isConnected = true; return el;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.parentElement = null; this.isConnected = false; }
  matches(sel) { return sel === '.zu-sr-only' && this.classList.contains('zu-sr-only'); }
  querySelector(k) {
    if (k.startsWith('.')) { const all = this.querySelectorAll(k); if (all.length) return all[0]; }
    if (k === '[data-testid="chat-context-usage-trigger"]') {
      for (const c of this.children) {
        if (c.dataset && c.dataset['data-testid'] === 'chat-context-usage-trigger') return c;
        const hit = c.querySelector && c.querySelector(k);
        if (hit) return hit;
      }
      return null;
    }
    if (!this.queries.has(k)) this.queries.set(k, new Element());
    return this.queries.get(k);
  }
  querySelectorAll(sel) {
    if (sel === '[data-testid="v4-model-config"]') {
      return this.children.filter(e => e.getAttribute('data-testid') === 'v4-model-config').concat(
        ...this.children.map(e => e.querySelectorAll(sel)));
    }
    if (sel === 'circle') return this.children.filter(e => e.tagName === 'CIRCLE').concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    if (sel === '.zu-sr-only') return this.children.filter(e => e.classList.contains('zu-sr-only')).concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    return [];
  }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return k === 'data-pane-id' ? !!this.pid : k === 'data-session-id' ? !!this.sid : Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return k === 'data-pane-id' ? (this.pid || null) : k === 'data-session-id' ? (this.sid || null) : (this.dataset[k] !== undefined ? this.dataset[k] : null); }
  getBoundingClientRect() { return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 }; }
}

function harness({ quotaOn = true, prefs = {} } = {}) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  /* 开关真值来自主进程推送的插件状态（config.json quota_enabled），不是 localStorage；
   * quotaOn:false 夹具模拟显式 false（v111 起缺省开） */
  window.__zusagePluginState = { quotaEnabled: quotaOn ? true : false };
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  /* v251：localStorage 桩改 map 承载，prefs 可预种子渲染端展示偏好（如 zusage3.quotaRemain）；
   * 空表行为与旧桩一致（getItem 缺失返回 null） */
  const lsStore = new Map(Object.entries(prefs));
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' },
    localStorage: { getItem: k => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => { lsStore.set(String(k), String(v)); } },
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; this.connected = true; }
      disconnect() { this.connected = false; }
    },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.quotaTest = { instances: function() { return instances; }, state: function() { return state; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function buildComposer(pid, sid, { live = false, provider = '', model = '' } = {}) {
    const pane = live ? body.appendChild(new Element()) : null;
    if (pane) {
      pane.setAttribute('data-testid', 'v4-session-pane-' + pid);
      pane.sid = sid;
    }
    const card = (pane || body).appendChild(new Element());
    const marker = live ? card.appendChild(new Element('span')) : null;
    if (marker) {
      marker.setAttribute('data-testid', 'v4-model-config');
      marker.setAttribute('data-provider', provider);
      marker.setAttribute('data-model', model);
    }
    const row = card.appendChild(new Element());
    row.className = 'group/toolbar flex items-end gap-3';
    const wrap = row.appendChild(new Element('span'));
    wrap.className = 'inline-flex shrink-0';
    const btn = wrap.appendChild(new Element('button'));
    btn.setAttribute('data-testid', 'chat-context-usage-trigger');
    btn.setAttribute('aria-label', '上下文已用 63,400 / 总量 200,000');
    const svg = btn.appendChild(new Element('svg'));
    svg.appendChild(new Element('circle'));
    svg.appendChild(new Element('circle'));
    const editor = card.appendChild(new Element('textarea'));
    editor.pid = pid; editor.sid = sid;
    panes.push(editor);
    return { card, row, wrap, btn, editor, pane, marker };
  }
  function payload({ provider = 'account:bigmodel-individual-coding-plan', model = 'GLM-5.3-Flash', quota } = {}) {
    const out = { remote_evidence: false, today: {}, not_local: [],
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
        last: { provider_id: provider, model } }] };
    if (quota !== undefined) out.quota = quota;
    return out;
  }
  const chipOf = wrap => wrap.children.find(e => e.classList.contains('zu-quota'));
  const liveOf = root => root.children.find(e => e.classList.contains('zu-sr-only'));
  const tipEl = () => body.children.find(e => e.className === 'tip zusage-quota-tip');
  function mutate(pane) {
    for (const o of [...observers]) if (o.connected && o.target === pane) o.fn([]);
  }
  return { window, body, inject, tick, boot, buildComposer, payload, chipOf, liveOf, tipEl, mutate, observers, lsStore };
}
module.exports = { harness, Element, source };
