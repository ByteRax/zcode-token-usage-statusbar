const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v92 原生上下文按钮增强：整 IIFE 执行 + instances 接缝（同 overlay-lifecycle 模式）。
 * 夹具：输入卡片内 group/toolbar 工具行放 wrapper span > button[data-testid] > svg > 双 circle，
 * 经 coordinator 派实例、__zusageUpdate 推数据后断言增强/换档/幂等/还原。 */
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
  // 真实 DOM 语义：className 赋值与 classList 同步（增强逻辑/断言都依赖 contains 能看到脚本写入的类）
  set className(v) { this._className = String(v); this.classes.clear(); this._className.split(/\s+/).filter(Boolean).forEach(c => this.classes.add(c)); }
  get className() { return this._className; }
  setAttribute(k, v) { this.dataset[k] = String(v); }
  removeAttribute(k) { delete this.dataset[k]; }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  appendChild(el) { this.children.push(el); el.parentElement = this; return el; }
  insertBefore(el, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    const idx = this.children.indexOf(ref);
    if (el.parentElement) el.remove();
    this.children.splice(idx, 0, el); el.parentElement = this; return el;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.isConnected = false; }
  querySelector(k) {
    if (k === '[data-testid="chat-context-usage-trigger"]') {
      for (const c of this.children) {
        if (c.dataset && c.dataset['data-testid'] === 'chat-context-usage-trigger') return c;
        const hit = c.querySelector && c.querySelector(k);
        if (hit) return hit;
      }
      return null;
    }
    // 与 lifecycle 夹具同语义：未预注册的选择器返回可写的空元素，面板构建等假设节点存在
    if (!this.queries.has(k)) this.queries.set(k, new Element());
    return this.queries.get(k);
  }
  querySelectorAll(sel) {
    if (sel !== 'circle') return [];
    return this.children.filter(e => e.tagName === 'CIRCLE').concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
  }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return k === 'data-pane-id' ? !!this.pid : k === 'data-session-id' ? !!this.sid : Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return k === 'data-pane-id' ? (this.pid || null) : k === 'data-session-id' ? (this.sid || null) : (this.dataset[k] !== undefined ? this.dataset[k] : null); }
  getBoundingClientRect() { return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 }; }
}

function harness() {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' }, localStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.ctxBtnTest = { instances: function() { return instances; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function buildComposer(pid, sid, { ariaLabel = '上下文已用 63,400 / 总量 200,000' } = {}) {
    const card = body.appendChild(new Element());
    const row = card.appendChild(new Element());
    row.className = 'group/toolbar flex items-end gap-3';
    const wrap = row.appendChild(new Element('span'));
    wrap.className = 'inline-flex shrink-0';
    const btn = wrap.appendChild(new Element('button'));
    btn.setAttribute('data-testid', 'chat-context-usage-trigger');
    btn.setAttribute('aria-label', ariaLabel);
    const svg = btn.appendChild(new Element('svg'));
    svg.appendChild(new Element('circle'));
    const value = svg.appendChild(new Element('circle'));
    const editor = card.appendChild(new Element('textarea'));
    editor.pid = pid; editor.sid = sid;
    panes.push(editor);
    return { card, row, wrap, btn, svg, value, editor };
  }
  function payload({ ctx = 63400, cw = 200000, exc = 0 } = {}) {
    return { remote_evidence: false, today: {}, not_local: [],
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx, context_window: cw, last_at: 1, ctx_exc: exc }] };
  }
  return { window, body, inject, tick, boot, buildComposer, payload };
}

test('enhanced ring mirrors the statusbar band and appends a percentage beside the button', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), '1');
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'ok');
  assert.equal(ui.value.getAttribute('pathLength'), '100');
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '31.7 100');
  assert.equal(ui.value.getAttribute('stroke-dashoffset'), '0');
  assert.equal(ui.value.getAttribute('stroke-linecap'), 'round');
  const pct = ui.btn.children.find(e => e.classList.contains('zu-ctxpct'));
  assert.ok(pct && pct.textContent === '31.7%' && pct.className === 'zu-ctxpct pct ok');
  // 数值挂 trigger 按钮内（环右侧）：悬停数值 = 悬停按钮，原生 hover-card 与 hover 效果自动生效
  assert.equal(ui.btn.children.indexOf(pct) > ui.btn.children.indexOf(ui.svg), true);
  assert.equal(pct.listeners.size, 0);   // 不做事件截停
});

test('react commit that displaces the percentage is healed back to the ring\'s right side', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  const pct = ui.btn.children.find(e => e.classList.contains('zu-ctxpct'));
  ui.btn.children.splice(ui.btn.children.indexOf(pct), 1);   // 模拟 React appendChild 把手动节点挤到环之前
  ui.btn.children.unshift(pct);
  h.tick();
  assert.equal(ui.btn.children[ui.btn.children.length - 1], pct);
});

test('band follows the shared thresholds: normal 70/85, million window 40/60, over-limit first', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ ctx: 140000 }));   // 70% of 200k
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'warm');
  h.window.__zusageUpdate(h.payload({ ctx: 170000 }));   // 85% of 200k
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'hot');
  h.window.__zusageUpdate(h.payload({ ctx: 450000, cw: 1000000 }));   // 45% of 1M
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'warm');
  h.window.__zusageUpdate(h.payload({ ctx: 450000, cw: 1000000, exc: 2 }));
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'exc');
});

test('reapply is idempotent: one percentage node, attribute writes only on change', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  const first = ui.btn.children.find(e => e.classList.contains('zu-ctxpct'));
  h.window.__zusageUpdate(h.payload());
  h.tick(); h.tick();
  const again = ui.btn.children.find(e => e.classList.contains('zu-ctxpct'));
  assert.equal(again, first);
  assert.equal(ui.btn.children.filter(e => e.classList.contains('zu-ctxpct')).length, 1);
});

test('react rewrite of dasharray is healed by the heavy reconcile within one tick', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  ui.value.setAttribute('stroke-dasharray', '62.83185307179586 62.83185307179586');   // 模拟宿主数据更新重写
  h.tick();
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '31.7 100');
});

test('unknown capacity restores the native ring and removes the percentage', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  assert.ok(ui.btn.getAttribute('data-zusage-armed'));
  h.window.__zusageUpdate(h.payload({ ctx: 63400, cw: 0 }));
  h.tick();
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), null);
  assert.equal(ui.btn.getAttribute('data-zusage-band'), null);
  assert.equal(ui.btn.children.find(e => e.classList.contains('zu-ctxpct')), undefined);
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '62.83185307179586 62.83185307179586');
  assert.equal(ui.value.getAttribute('stroke-dashoffset'), String(62.83185307179586 * (1 - 63400 / 200000)));
  assert.equal(ui.value.getAttribute('pathLength'), null);
});

test('dispose restores the native form of its own pane button', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  assert.ok(ui.btn.getAttribute('data-zusage-armed'));
  h.window.ctxBtnTest.instances()[0].dispose();
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), null);
  assert.equal(ui.btn.children.find(e => e.classList.contains('zu-ctxpct')), undefined);
});

test('enhancement styles exist: band colors, geometry override, pct span and light variants', () => {
  assert.match(source, /\[data-testid=chat-context-usage-trigger\]\[data-zusage-armed\]\{color:#3ecf8e!important/);
  assert.match(source, /width:auto!important;min-width:1\.75rem;padding:0 3px;gap:4px\}/);
  assert.match(source, /\[data-zusage-armed\]\[data-zusage-band=hot\]\{color:#ff6b57!important\}/);
  assert.match(source, /\[data-zusage-armed\]\[data-zusage-band=exc\]\{color:var\(--color-destructive,#ff2d55\)!important/);
  assert.match(source, />svg:not\(\.animate-spin\) circle\{opacity:1;stroke-width:3;r:9px\}/);
  assert.match(source, />svg:not\(\.animate-spin\) circle:first-of-type\{stroke:var\(--color-hover/);
  assert.match(source, />svg:not\(\.animate-spin\) circle:last-of-type\{stroke:currentColor;stroke-linecap:round\}/);
  assert.match(source, /\.zu-ctxpct\{font-family:var\(--font-mono/);
  assert.doesNotMatch(source, /\.zu-ctxpct\{[^}]*pointer-events:none/);
  assert.doesNotMatch(source, /\.zu-ctxpct:hover/);
  assert.doesNotMatch(source, /pctEl\.addEventListener\(t, function \(e\) \{ e\.stopPropagation/);
  assert.match(source, /\[data-zusage-light\] \.zu-ctxpct\.ok\{color:#0f9d6c\}/);
});
