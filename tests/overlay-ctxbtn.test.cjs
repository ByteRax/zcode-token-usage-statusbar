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
    this.textContent = ''; this.innerHTMLWrites = 0; this.innerHTML = ''; this._className = ''; this.isConnected = true;
  }
  set innerHTML(v) { this._innerHTML = String(v); this.innerHTMLWrites++; }
  get innerHTML() { return this._innerHTML; }
  // 真实 DOM 语义：className 赋值与 classList 同步（增强逻辑/断言都依赖 contains 能看到脚本写入的类）
  set className(v) { this._className = String(v); this.classes.clear(); this._className.split(/\s+/).filter(Boolean).forEach(c => this.classes.add(c)); }
  get className() { return this._className; }
  setAttribute(k, v) { this.dataset[k] = String(v); }
  removeAttribute(k) { delete this.dataset[k]; }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  get nextSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  appendChild(el) {
    if (el.parentElement) el.remove();
    this.children.push(el); el.parentElement = this; el.isConnected = true; return el;
  }
  insertBefore(el, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    if (el === ref) return el;
    if (el.parentElement) el.remove();
    const idx = this.children.indexOf(ref);
    this.children.splice(idx, 0, el); el.parentElement = this; el.isConnected = true; return el;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this);
    this.parentElement = null; this.isConnected = false;
  }
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
    if (sel === '[data-testid="v4-model-config"]') {
      return this.children.filter(e => e.getAttribute('data-testid') === 'v4-model-config').concat(
        ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    }
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

function harness({ clock, ls } = {}) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  class FixtureDate extends Date { static now() { return clock ? clock.now : Date.now(); } }
  const sandbox = vm.createContext({ window, document, console, Date: FixtureDate, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' }, localStorage: { getItem: k => (ls && k in ls ? ls[k] : null), setItem() {} },
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
      observe(target) { this.target = target; this.connected = true; }
      disconnect() { this.connected = false; }
    },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.ctxBtnTest = { instances: function() { return instances; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function firePanelChange(target) {   // ⚙ 面板 change 委托真实路径（panel 挂 body，class "panel zu-settings"）
    const panel = body.children.find(e => e.classList && e.classList.contains('zu-settings'));
    assert.ok(panel, 'settings panel mounted');
    for (const fn of (panel.listeners.get('change') || [])) fn({ target });
  }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function runTimeouts() { for (const [n, t] of [...timers]) if (!t.interval) { timers.delete(n); t.fn(); } }
  function mutate(pane) { for (const o of [...observers]) if (o.connected && o.target === pane) o.fn([]); }
  function buildComposer(pid, sid, { ariaLabel = '上下文已用 63,400 / 总量 200,000',
    live = false, provider = 'account:bigmodel-individual-coding-plan', model = 'GLM-5.3' } = {}) {
    const pane = live ? body.appendChild(new Element()) : null;
    if (pane) { pane.setAttribute('data-testid', 'v4-session-pane-' + pid); pane.sid = sid; }
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
    btn.setAttribute('aria-label', ariaLabel);
    const svg = btn.appendChild(new Element('svg'));
    svg.appendChild(new Element('circle'));
    const value = svg.appendChild(new Element('circle'));
    const editor = card.appendChild(new Element('textarea'));
    editor.pid = pid; editor.sid = sid;
    panes.push(editor);
    return { card, row, wrap, btn, svg, value, editor, pane, marker };
  }
  function payload({ ctx = 63400, cw = 200000, exc = 0 } = {}) {
    return { remote_evidence: false, today: {}, not_local: [],
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx, context_window: cw, last_at: 1, ctx_exc: exc }] };
  }
  return { window, body, document, inject, tick, boot, runTimeouts, mutate, buildComposer, payload, firePanelChange };
}

test('enhanced ring mirrors the statusbar band and appends a percentage beside the button', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), '1');
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'norm');   // 31.7% ≥30 → norm（indigo）
  assert.equal(ui.value.getAttribute('pathLength'), '100');
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '31.7 100');
  assert.equal(ui.value.getAttribute('stroke-dashoffset'), '0');
  assert.equal(ui.value.getAttribute('stroke-linecap'), 'round');
  const pct = ui.btn.children.find(e => e.classList.contains('zu-ctxpct'));
  assert.ok(pct && pct.textContent === '31.7%' && pct.className === 'zu-ctxpct pct norm');
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

test('band follows user bands 30/50/80/90 (inclusive lower bound), compression state first', () => {
  // fallback 标签走 DB 兜底路径，专测 ctxBandOf 分档表边界（原生镜像分档另有用例）
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main', { ariaLabel: '剩余额度' });
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ ctx: 59000 }));   // 29.5% of 200k
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'calm');
  h.window.__zusageUpdate(h.payload({ ctx: 60000 }));   // 30% 整
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'norm');
  h.window.__zusageUpdate(h.payload({ ctx: 100000 }));   // 50% 整
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'mid');
  h.window.__zusageUpdate(h.payload({ ctx: 160000 }));   // 80% 整
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'high');
  h.window.__zusageUpdate(h.payload({ ctx: 180000 }));   // 90% 整
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'crit');
  h.window.__zusageUpdate(h.payload({ ctx: 450000, cw: 1000000, exc: 2 }));   // 压缩过程态仍优先
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

/* ---------- issue #172：压缩上下文后徽标必须跟随原生 aria-label 立即刷新 ----------
 * 宿主 taskUsage store（悬停面板同源）压缩后立即回落，React 只更新按钮 aria-label；
 * DB 快照要等下一条请求完成才有新值 → 原生 label 可解析时显示层优先镜像原生占比。 */
test('issue #172: compaction refreshes ring+pct from the native label without a new DB row', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '31.7 100');
  // 用户点【压缩上下文】：宿主立即回落到 1.2%，React 只更新 aria-label（DB 无新完成请求）
  ui.btn.setAttribute('aria-label', '上下文已用 2,400 / 总量 200,000');
  h.tick();   // heavy 对账（≤600ms）刷新，不依赖 __zusageUpdate 快照推送
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '1.2 100');
  const pct = ui.btn.children.find(e => e.classList.contains('zu-ctxpct'));
  assert.equal(pct.textContent, '1.2%');
  assert.equal(pct.className, 'zu-ctxpct pct calm');   // 分档同表重算：1.2% → calm
});

test('English aria-label (Context usage X of Y) mirrors the same way', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main',
    { ariaLabel: 'Context usage 100,000 of 200,000' });
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());   // DB 口径 31.7%，原生镜像 50%
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '50.0 100');
  const pct = ui.btn.children.find(e => e.classList.contains('zu-ctxpct'));
  assert.equal(pct.textContent, '50.0%');
  assert.equal(pct.className, 'zu-ctxpct pct mid');
});

test('aria-label without usage data falls back to the DB-derived band', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main',
    { ariaLabel: '剩余额度' });
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '31.7 100');
  const pct = ui.btn.children.find(e => e.classList.contains('zu-ctxpct'));
  assert.equal(pct.textContent, '31.7%');
  assert.equal(pct.className, 'zu-ctxpct pct norm');
});

test('native mirroring keeps the compression-state band priority (exc)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main',
    { ariaLabel: '上下文已用 2,400 / 总量 200,000' });
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ ctx: 63400, cw: 200000, exc: 2 }));
  assert.equal(ui.btn.getAttribute('data-zusage-band'), 'exc');
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '1.2 100');   // 环口径跟原生，档位 exc 优先
});

test('parse boundaries: 0/0 falls back, >total clamps, case tolerance', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main',
    { ariaLabel: '上下文已用 0 / 总量 0' });
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '31.7 100');   // 0/0 → DB 兜底，不得显示 NaN%
  ui.btn.setAttribute('aria-label', '上下文已用 250,000 / 总量 200,000');
  h.tick();
  assert.equal(ui.btn.children.find(e => e.classList.contains('zu-ctxpct')).textContent, '100.0%');   // 超总量截断
  ui.btn.setAttribute('aria-label', 'Context Usage 100,000 of 200,000');   // 大小写容错
  h.tick();
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '50.0 100');
  ui.btn.setAttribute('aria-label', '上下文已用 2，400 / 总量 200，000');   // 全角逗号：剥离与匹配同权
  h.tick();
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '1.2 100');
});

test('native label rescues the enhancement when the DB lacks a context window', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ ctx: 63400, cw: 0 }));
  h.tick();
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), '1');
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '31.7 100');   // 镜像原生 self-consistent 占比
});

test('unknown capacity restores the native ring and removes the percentage', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main', { ariaLabel: '剩余额度' });
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  assert.ok(ui.btn.getAttribute('data-zusage-armed'));
  h.window.__zusageUpdate(h.payload({ ctx: 63400, cw: 0 }));
  h.tick();
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), null);
  assert.equal(ui.btn.getAttribute('data-zusage-band'), null);
  assert.equal(ui.btn.children.find(e => e.classList.contains('zu-ctxpct')), undefined);
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '62.83185307179586 62.83185307179586');
  assert.equal(ui.value.getAttribute('stroke-dashoffset'), String(62.83185307179586));   // 无已用数据退空环
  assert.equal(ui.value.getAttribute('pathLength'), null);
});

test('dispose restore derives the native dashoffset from an English aria-label', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main',
    { ariaLabel: 'Context usage 100,000 of 200,000' });
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), '1');
  h.window.ctxBtnTest.instances()[0].dispose();
  assert.equal(ui.value.getAttribute('stroke-dashoffset'), String(62.83185307179586 * (1 - 0.5)));
});

/* ---------- v156 上下文按钮增强开关（issue #141，localStorage zusage3.ctxEnh 缺省开） ---------- */
test('enhancement toggle off (zusage3.ctxEnh=0) never touches the native button', () => {
  const h = harness({ ls: { 'zusage3.ctxEnh': '0' } }), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  h.tick();
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), null);
  assert.equal(ui.btn.getAttribute('data-zusage-band'), null);
  assert.equal(ui.btn.children.find(e => e.classList.contains('zu-ctxpct')), undefined);
  assert.equal(ui.value.getAttribute('pathLength'), null);
  assert.equal(ui.value.getAttribute('stroke-dasharray'), null);   // 环属性完全不动（宿主原生语义）
});

test('runtime off via the panel toggle restores the ring and keeps the reset badge', () => {
  const ls = {}; const h = harness({ ls }), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(25 * 3600e3, 2) }));
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), '1');
  assert.ok(rst(ui.btn), 'badge mounts while enhanced');
  const toggle = { checked: false, type: 'checkbox', dataset: {}, classList: { contains: n => n === 'zu-ctx-enh' } };
  h.firePanelChange(toggle);   // 真实 change 委托：state.ctxEnh=0 → persist → renderAll
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), null);
  assert.equal(ui.btn.getAttribute('data-zusage-band'), null);
  assert.equal(ui.btn.children.find(e => e.classList.contains('zu-ctxpct')), undefined);
  assert.equal(ui.value.getAttribute('pathLength'), null);
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '62.83185307179586 62.83185307179586');
  assert.equal(ui.value.getAttribute('stroke-dashoffset'), String(62.83185307179586 * (1 - 63400 / 200000)));
  // 徽标仅借按钮定位，还原后继续维护（restore 清掉的徽标立即重挂）
  const b = rst(ui.btn);
  assert.ok(b, 'reset badge survives turning enhancement off');
  assert.match(b.innerHTML, /<\/svg>2$/);
  assert.equal(b.className, 'zu-ctxrst zu-rst-calm');
  toggle.checked = true;
  h.firePanelChange(toggle);   // 再开启：增强恢复
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), '1');
  assert.equal(ui.value.getAttribute('stroke-dasharray'), '31.7 100');
  assert.ok(ui.btn.children.find(e => e.classList.contains('zu-ctxpct')));
});

test('reset badge still mounts when enhancement is disabled from startup', () => {
  const h = harness({ ls: { 'zusage3.ctxEnh': '0' } }), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(25 * 3600e3, 2) }));
  assert.equal(ui.btn.getAttribute('data-zusage-armed'), null);
  const b = rst(ui.btn);
  assert.ok(b, 'badge exists without enhancement');
  assert.equal(b.className, 'zu-ctxrst zu-rst-calm');
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
  assert.match(source, /\[data-testid=chat-context-usage-trigger\]\[data-zusage-armed\]\{color:#3ecf8e!important/);   // calm 基色=三档绿
  assert.match(source, /\[data-zusage-armed\]\[data-zusage-band=mid\],\[data-testid=chat-context-usage-trigger\]\[data-zusage-armed\]\[data-zusage-band=high\]\{color:#f5b944!important\}/);   // mid+high 同黄
  assert.match(source, /\[data-zusage-armed\]\[data-zusage-band=crit\]\{color:#ff6b57!important\}/);
  assert.match(source, /width:auto!important;min-width:1\.75rem;padding:0 3px;gap:4px\}/);
  assert.match(source, /\[data-zusage-armed\]\[data-zusage-band=exc\]\{color:var\(--color-destructive,#ff2d55\)!important/);
  assert.match(source, />svg:not\(\.animate-spin\) circle\{opacity:1;stroke-width:3;r:9px\}/);
  assert.match(source, />svg:not\(\.animate-spin\) circle:first-of-type\{stroke:var\(--color-hover/);
  assert.match(source, />svg:not\(\.animate-spin\) circle:last-of-type\{stroke:currentColor;stroke-linecap:round\}/);
  // v133 定稿：额度与上下文百分比两处显式同字体——14px（--ui-font-size）+ 加粗 + 等宽 +
  // tabular-nums（用户规格 2026-10-28；不靠继承：工具栏容器字号偏小致两段不一致）
  assert.match(source, /\.zu-ctxpct\{display:inline-flex;align-items:center;flex:0 0 auto;/);
  assert.match(source.slice(source.indexOf('\".zu-ctxpct{'), source.indexOf('\".zu-ctxpct{') + 600), /font-size:calc\(var\(--text-ui-base,var\(--ui-font-size,14px\)\) - 1px\);font-weight:700;font-variant-numeric:tabular-nums\}/);
  assert.doesNotMatch(source, /\.zu-ctxpct\{[^}]*pointer-events:none/);
  assert.doesNotMatch(source, /\.zu-ctxpct:hover/);
  assert.doesNotMatch(source, /pctEl\.addEventListener\(t, function \(e\) \{ e\.stopPropagation/);
  assert.doesNotMatch(source, /\[data-zusage-armed\] \.zu-ctxpct\.ok\{color:#72c9a2\}/);   // v131 pct 与环一律继承按钮色
  assert.match(source, /\[data-zusage-light\]\[data-zusage-armed\]\[data-zusage-band=calm\],\[data-zusage-light\]\[data-zusage-armed\]\[data-zusage-band=norm\]\{color:#0f9d6c!important\}/);   // 浅色档带 armed 补特异性（0,3,0 同暗色规则，源序在后胜出）
  assert.match(source, /\[data-zusage-light\]\[data-zusage-armed\]\[data-zusage-band=crit\]\{color:#d8482f!important\}/);
  assert.doesNotMatch(source, /\[data-zusage-light\]\[data-zusage-band=(?:norm|mid|high|crit)\]\{color:/);   // 旧两属性浅色规则不得回潮（会被暗色 0,3,0 恒胜）
  // v135 教训：拼串插行把字体声明拆出规则块（悬空右括号）会吞掉后面的档位色规则——
  // 基础块内不得再出现选择器花括号，档位色必须仍能紧跟其后
  assert.match(source, /\.zu-ctxrst\{[^{}]*font-variant-numeric:tabular-nums\}/);
  assert.match(source, /\.zu-ctxrst\.zu-rst-calm\{color:#3ecf8e\}/);
});

/* ---------- v135 重置卡徽标（.zu-ctxrst） ---------- */
function resetComposer(h, provider = 'account:bigmodel-individual-coding-plan', ariaLabel) {
  return h.buildComposer('workspace-main', 'sid_main',
    Object.assign({ live: true, provider }, ariaLabel ? { ariaLabel } : {}));
}
function rstEntry(expireInMs, count = 2) {
  return { status: "ok", count, expireAt: Date.now() + expireInMs,
    fiveHour: Array.from({ length: count }, () => ({ expireAt: Date.now() + expireInMs })), week: [],
    fetchedAt: Date.now() - 1000, stale: false, busy: false, error: "" };
}
function payloadWithResets(base, resets) {
  const p = base();
  p.recent[0].last = { provider_id: "account:bigmodel-individual-coding-plan" };
  p.quota = { sources: {}, resets };
  return p;
}
const rst = (el) => { const host = el.parentElement && el.parentElement.parentElement;   // v135 定稿：工具行内、wrapper 左侧
  return host && host.children.find(e => e.classList.contains('zu-ctxrst')); };

test('reset badge mounts left of the quota group with calm band and no countdown beyond threshold', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(25 * 3600e3, 2) }));
  const b = rst(ui.btn);
  assert.ok(b, 'badge exists');
  assert.match(b.innerHTML, /<svg aria-hidden="true"/);
  assert.match(b.innerHTML, /M3 12a9 9/);   // 图标为 refresh 双箭头 SVG
  assert.match(b.innerHTML, /<\/svg>2$/);
  assert.equal(b.className, 'zu-ctxrst zu-rst-calm');
  // 定稿挂载点：工具行内、wrapper（额度 chip+按钮组）左侧（用户规格 2026-10-28）
  assert.equal(b.parentElement, ui.row);
  assert.equal(ui.row.children.indexOf(b) + 1, ui.row.children.indexOf(ui.btn.parentElement));
});

test('both families contribute to the badge and countdown', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, {
    bigmodel: rstEntry(2 * 3600e3, 2), zai: rstEntry(5 * 3600e3, 3) }));
  const b = rst(ui.btn);
  assert.match(b.innerHTML, /<\/svg>2\+3 · /);
  assert.match(b.innerHTML, /\d+时\d+分\d+秒/);   // 时分秒全档、精确到秒（用户规格 2026-10-28）
  assert.equal(b.className, 'zu-ctxrst zu-rst-mid zu-rst-cd');   // 全局最早 2h → 黄（阈值内带倒计时类）
  // 阈值外（>24h）不显示倒计时
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(25 * 3600e3, 2) }));
  assert.match(rst(ui.btn).innerHTML, /<\/svg>2$/);
});

test('urgency bands: >3h calm green, 3h-30min mid yellow, <30min crit red with pulse class', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(3 * 3600e3 + 60e3) }));
  assert.equal(rst(ui.btn).className, 'zu-ctxrst zu-rst-calm zu-rst-cd');
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(3 * 3600e3 - 60e3) }));
  assert.equal(rst(ui.btn).className, 'zu-ctxrst zu-rst-mid zu-rst-cd');
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(29 * 60e3) }));
  assert.equal(rst(ui.btn).className, 'zu-ctxrst zu-rst-crit zu-rst-cd');
  assert.match(source, /\.zu-ctxrst\.zu-rst-crit\{color:#ff6b57;animation:zupulse 1s ease-in-out infinite\}/);
});

test('expired cards (expireAt <= now, data not yet refreshed) render nothing', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(-60e3) }));
  assert.equal(rst(ui.btn), undefined);
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: { status: 'ok', count: 0, expireAt: 0, fiveHour: [], week: [] } }));
  assert.equal(rst(ui.btn), undefined);
});

test('badge follows the independent resetBadgeEnabled gate, not the quota chip fields', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(3600e3) }));
  assert.ok(rst(ui.btn));
  h.window.__zusagePluginUpdate({ resetBadgeEnabled: false });
  h.tick();
  assert.equal(rst(ui.btn), undefined);   // 关开关即摘除
  h.window.__zusagePluginUpdate({ resetBadgeEnabled: true });
  h.tick();
  assert.ok(rst(ui.btn), 're-enabled restores the badge');
});

test('unknown capacity restores the native form including the reset badge', () => {
  const h = harness(), ui = resetComposer(h, 'account:bigmodel-individual-coding-plan', '剩余额度');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(3600e3) }));
  assert.ok(rst(ui.btn));
  h.window.__zusageUpdate(payloadWithResets(() => h.payload({ ctx: 63400, cw: 0 }), { bigmodel: rstEntry(3600e3) }));
  h.tick();
  assert.equal(rst(ui.btn), undefined);
});



test('moving the pointer from the badge into the tooltip keeps it open for the how-to button', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.zcode = { openExternal: (u) => opened.push(u) };
  const opened = [];
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(2 * 3600e3, 1) }));
  const b = rst(ui.btn);
  b.listeners.get('mouseenter')[0].call(b);
  const tip = h.document.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  // 指针经 8px 间隙移向 tooltip：徽标 leave 进入延迟窗口，进入 tooltip 取消收起
  b.listeners.get('mouseleave')[0].call(b);
  tip.listeners.get('mouseenter')[0].call(tip);
  h.runTimeouts();
  assert.equal(tip.style.display, 'block', 'tooltip survives the gap while the pointer is on it');
  const clickListener = tip.listeners.get('click')[0];
  const btnStub = { classList: { contains: (c) => c === 'rst-howto' }, closest: (sel) => sel === '.rst-howto' ? btnStub : null };
  clickListener.call(tip, { target: btnStub, stopPropagation() {} });
  assert.deepEqual(opened, ['https://bigmodel.cn/coding-plan/personal/usage']);
  // 离开 tooltip：延迟窗口内未回到徽标即收起
  tip.listeners.get('mouseleave')[0].call(tip);
  h.runTimeouts();
  assert.equal(tip.style.display, 'none');
});




test('tooltip renders expired cards from the legacy history field (old cold main process)', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  const now = Date.now();
  h.window.__zusageUpdate(payloadWithResets(h.payload, {
    bigmodel: { status: 'ok', count: 2, expireAt: now + 3600e3,
      fiveHour: [{ expireAt: now + 3600e3 }, { expireAt: now + 7200e3 }], week: [],
      /* 17:32 版冷主进程形状：history 而非 list */
      history: { fiveHour: [{ expireAt: now - 3600e3 }, { expireAt: now - 9 * 86400e3 }], week: [] },
      fetchedAt: now - 1000, stale: false, busy: false, error: '' } }));
  const b = rst(ui.btn);
  b.listeners.get('mouseenter')[0].call(b);
  const tip = h.document.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.equal((tip.innerHTML.match(/已过期/g) || []).length, 1);   // 7 天内的过期卡保留，超期丢弃
  assert.match(tip.innerHTML, /5小时卡 · 到期/);                     // 有效行照常
  assert.ok(tip.innerHTML.indexOf('到期') < tip.innerHTML.indexOf('已过期'));
  b.listeners.get('mouseleave')[0].call(b);
});

test('tooltip omits group headers for families without cards (e.g. unconfigured Z.ai)', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, {
    bigmodel: rstEntry(2 * 3600e3, 2),
    zai: { status: 'not_configured', fetchedAt: 0, stale: false, busy: false, error: '' } }));
  const b = rst(ui.btn);
  b.listeners.get('mouseenter')[0].call(b);
  const tip = h.document.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.match(tip.innerHTML, /BigModel/);
  assert.doesNotMatch(tip.innerHTML, /Z\.ai/);   // 无卡账号族不渲染空组头（用户反馈 2026-10-28）
  b.listeners.get('mouseleave')[0].call(b);
  h.runTimeouts();
});

test('tooltip rows show grantType prefix when list data is present, falling back to status rows', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  const now = Date.now();
  h.window.__zusageUpdate(payloadWithResets(h.payload, {
    bigmodel: { status: 'ok', count: 1, expireAt: now + 3600e3,
      fiveHour: [{ expireAt: now + 3600e3 }], week: [],
      list: { fiveHour: [
        { expireAt: now + 3600e3, grantType: 'GLOBAL', available: true },
        { expireAt: now - 7200e3, grantType: 'ACTIVITY', available: false } ],
        week: [] },
      fetchedAt: now - 1000, stale: false, busy: false, error: '' } }));
  const b = rst(ui.btn);
  b.listeners.get('mouseenter')[0].call(b);
  const tip = h.document.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.match(tip.innerHTML, /全局 5小时卡 · 到期/);          // 行首 = grantType 中文映射（GLOBAL→全局）
  assert.match(tip.innerHTML, /ACTIVITY 5小时卡 · 已过期/);    // 未知枚举值兜底显示原文
  assert.ok(tip.innerHTML.indexOf('GLOBAL') < tip.innerHTML.indexOf('ACTIVITY'), 'valid rows sort before expired rows');
  assert.doesNotMatch(tip.innerHTML, />\s*5小时卡 · 到期/);   // 有列表数据时不再渲染无前缀的 status 行
  // 无列表数据的族回退 status 行（无 grantType 前缀）
  h.window.__zusageUpdate(payloadWithResets(h.payload, {
    bigmodel: { status: 'ok', count: 1, expireAt: now + 3600e3,
      fiveHour: [{ expireAt: now + 3600e3 }], week: [],
      fetchedAt: now - 1000, stale: false, busy: false, error: '' } }));
  assert.match(tip.innerHTML, /5小时卡 · 到期/);
  assert.doesNotMatch(tip.innerHTML, /GLOBAL/);
  b.listeners.get('mouseleave')[0].call(b);
});

test('reset tooltip shows color legend, cadence note and a how-to button opening the console via openExternal', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  const opened = [];
  h.window.zcode = { openExternal: (u) => opened.push(u) };   // 客户端桥桩
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(2 * 3600e3, 1) }));
  const b = rst(ui.btn);
  b.listeners.get('mouseenter')[0].call(b);
  const tip = h.document.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.ok(tip, 'tooltip visible');
  // 颜色图例：三档色点（类名驱动，含浅色组）与阈值文案
  assert.equal((tip.innerHTML.match(/rst-dot zu-rdot-/g) || []).length, 3);
  assert.match(tip.innerHTML, /zu-rdot-calm/);
  assert.match(tip.innerHTML, /zu-rdot-mid/);
  assert.match(tip.innerHTML, /zu-rdot-crit/);
  assert.match(tip.innerHTML, /&lt;30 分钟/);
  assert.match(tip.innerHTML, /30 分钟–3 小时/);
  assert.match(tip.innerHTML, /&gt;3 小时/);
  // 刷新节奏描述
  assert.match(tip.innerHTML, /每 5 分钟查询一次/);
  assert.match(tip.innerHTML, /倒计时按本机时钟推算/);
  // 「如何重置」按钮：存在且点击走 openExternal（系统默认浏览器）
  assert.match(tip.innerHTML, /rst-howto/);
  assert.match(tip.innerHTML, /如何重置/);
  // 夹具 innerHTML 不解析子树：用最小桩模拟被点击的按钮目标（closest 命中 .rst-howto）
  const btn = { classList: { contains: (c) => c === 'rst-howto' }, closest: (sel) => sel === '.rst-howto' ? this : null };
  btn.closest = (sel) => sel === '.rst-howto' ? btn : null;
  assert.match(tip.innerHTML, /class="rst-howto"/);
  const tipListener = tip.listeners.get('click')[0];
  tipListener.call(tip, { target: btn, stopPropagation() {} });
  assert.deepEqual(opened, ['https://bigmodel.cn/coding-plan/personal/usage']);
  // 无客户端桥时回落 window.open
  delete h.window.zcode;
  const winOpened = [];
  h.window.open = (u) => { winOpened.push(u); };
  tipListener.call(tip, { target: btn, stopPropagation() {} });
  assert.deepEqual(winOpened, ['https://bigmodel.cn/coding-plan/personal/usage']);
  b.listeners.get('mouseleave')[0].call(b);
});

test('reset tooltip retains recently expired cards returned by the server with 已过期 label', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  const now = Date.now();
  h.window.__zusageUpdate(payloadWithResets(h.payload, {
    bigmodel: { status: 'ok', count: 1, expireAt: now + 3600e3,
      fiveHour: [{ expireAt: now + 3600e3 }, { expireAt: now - 3600e3 }, { expireAt: now - 8 * 86400e3 }],
      week: [], fetchedAt: now - 1000, stale: false, busy: false, error: '' } }));
  const b = rst(ui.btn);
  b.listeners.get('mouseenter')[0].call(b);
  const tip = h.document.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.match(tip.innerHTML, /已过期/);                       // 服务端仍返回的未满 7 天过期卡照常展示
  assert.equal((tip.innerHTML.match(/已过期/g) || []).length, 1);   // 超 7 天的过期卡不再展示
  b.listeners.get('mouseleave')[0].call(b);
});

test('reset badge styles exist: font chain, three-band palette with light variants, crit pulse', () => {
  assert.match(source, /\.zu-ctxrst\{display:inline-flex;align-items:center;flex:0 0 auto;white-space:nowrap;/);
  assert.match(source.slice(source.indexOf('".zu-ctxrst{'), source.indexOf('".zu-ctxrst{') + 700),
    /font-size:calc\(var\(--text-ui-base,var\(--ui-font-size,14px\)\) - 1px\);font-weight:700;font-variant-numeric:tabular-nums\}/);
  assert.match(source, /\.zu-ctxrst\.zu-rst-calm\{color:#3ecf8e\}/);
  assert.match(source, /\.zu-ctxrst\.zu-rst-mid\{color:#f5b944\}/);
  assert.match(source, /\.zu-ctxrst\.zu-rst-crit\{color:#ff6b57;animation:zupulse 1s ease-in-out infinite\}/);
  assert.match(source, /\[data-zusage-light\] \.zu-ctxrst\.zu-rst-calm\{color:#0f9d6c\}/);
  assert.match(source, /\[data-zusage-light\] \.zu-ctxrst\.zu-rst-mid\{color:#b6791a\}/);
  assert.match(source, /\[data-zusage-light\] \.zu-ctxrst\.zu-rst-crit\{color:#d8482f\}/);
});

test('reset tooltip renders per-family per-card details with yyyy-MM-dd HH:mm times', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, {
    bigmodel: { status: 'ok', count: 2, expireAt: Date.now() + 3600e3,
      fiveHour: [{ expireAt: Date.now() + 3600e3 }, { expireAt: Date.now() + 7200e3 }], week: [],
      fetchedAt: Date.now() - 1000, stale: false, busy: false, error: '' },
    zai: { status: 'ok', count: 1, expireAt: Date.now() + 3600e3,
      fiveHour: [], week: [{ expireAt: Date.now() + 3600e3 }],
      fetchedAt: Date.now() - 1000, stale: false, busy: false, error: '' } }));
  const b = rst(ui.btn);
  assert.ok(b.__zuR && b.__zuR.fams.length === 2);
  b.listeners.get('mouseenter')[0].call(b);
  const tip = h.document.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.ok(tip, 'tooltip visible');
  assert.match(tip.innerHTML, /BigModel/);
  assert.equal((tip.innerHTML.match(/5小时卡/g) || []).length, 2);
  assert.match(tip.innerHTML, /Z\.ai/);
  assert.match(tip.innerHTML, /周卡/);
  assert.match(tip.innerHTML, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);   // 过期时刻精确到秒（用户规格 2026-10-28）
  assert.doesNotMatch(tip.innerHTML, /悬停额度 chip 可手动刷新|Hover the quota chip to refresh/);
  b.listeners.get('mouseleave')[0].call(b);
  assert.equal(tip.style.display, 'block', 'hide is deferred so the pointer can reach the tooltip');
  h.runTimeouts();
  assert.equal(tip.style.display, 'none');   // 延迟窗口内未进入 tooltip：照常收起
});

test('open reset tooltip updates with card data and stays unchanged across identical reconciles', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  const p = payloadWithResets(h.payload, { bigmodel: rstEntry(3600e3, 1) });
  h.window.__zusageUpdate(p);
  const badge = rst(ui.btn);
  badge.listeners.get('mouseenter')[0].call(badge);
  const tip = h.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.ok(tip);
  assert.equal((tip.innerHTML.match(/5小时卡/g) || []).length, 1);
  let writes = tip.innerHTMLWrites;
  h.tick(); h.tick();
  assert.equal(tip.innerHTMLWrites, writes, 'unchanged reconciles do not rebuild the open tooltip');
  p.quota.resets.bigmodel.fiveHour.push({ expireAt: Date.now() + 7200e3 });
  h.window.__zusageUpdate(p);
  assert.equal(rst(ui.btn), badge);
  assert.equal((tip.innerHTML.match(/5小时卡/g) || []).length, 2, 'new cards appear without leaving the badge');
  assert.equal(tip.innerHTMLWrites, writes + 1, 'changed details rebuild the tooltip once');
  writes = tip.innerHTMLWrites;
  h.tick(); h.window.__zusageUpdate(p); h.tick();
  assert.equal(tip.innerHTMLWrites, writes, 'same data does not rebuild the tooltip again');
});

test('open reset tooltip updates at expiry and closes when the final card expires', () => {
  const clock = { now: 1800000000000 }, h = harness({ clock }), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  const entry = { status: 'ok', fiveHour: [{ expireAt: clock.now + 1000 }],
    week: [{ expireAt: clock.now + 3600e3 }], fetchedAt: clock.now, stale: false, busy: false };
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: entry }));
  const badge = rst(ui.btn);
  badge.listeners.get('mouseenter')[0].call(badge);
  const tip = h.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.ok(tip);
  assert.doesNotMatch(tip.innerHTML, /已过期 /);
  const writes = tip.innerHTMLWrites;
  clock.now += 1000;
  h.tick();
  assert.equal(tip.style.display, 'block');
  assert.equal((tip.innerHTML.match(/已过期 /g) || []).length, 1, 'the expired card updates without a new payload');
  assert.equal(tip.innerHTMLWrites, writes + 1);
  assert.equal(rst(ui.btn).__zuR.total, 1);
  h.tick();
  assert.equal(tip.innerHTMLWrites, writes + 1);
  clock.now += 3600e3;
  h.tick();
  assert.equal(rst(ui.btn), undefined);
  assert.equal(tip.style.display, 'none');
});


test('live pane provider switches hide the badge and tooltip immediately, then restore it', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  const p = payloadWithResets(h.payload, { bigmodel: rstEntry(3600e3, 2), zai: rstEntry(7200e3, 3) });
  h.window.__zusageUpdate(p);
  assert.match(rst(ui.btn).innerHTML, /<\/svg>2\+3 · /);
  rst(ui.btn).listeners.get('mouseenter')[0].call(rst(ui.btn));
  const tip = h.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.ok(tip, 'tooltip starts open');
  ui.marker.setAttribute('data-provider', 'new-provider-ds');
  h.mutate(ui.pane);
  assert.equal(p.recent[0].last.provider_id, 'account:bigmodel-individual-coding-plan', 'DB history is unchanged');
  assert.equal(rst(ui.btn), undefined, 'third-party selection hides the badge before the next snapshot');
  assert.equal(tip.style.display, 'none', 'tooltip closes when the badge is removed');
  ui.marker.setAttribute('data-provider', 'account:zai-individual-coding-plan');
  h.mutate(ui.pane);
  const restored = rst(ui.btn);
  assert.ok(restored, 'switching back restores the cached cards');
  assert.match(restored.innerHTML, /<\/svg>2\+3 · /);
  assert.equal(restored.parentElement, ui.row);
  assert.equal(ui.row.children.indexOf(restored) + 1, ui.row.children.indexOf(ui.wrap), 'badge stays left of the quota group after restore');
});

test('only explicit personal account markers display reset cards', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(3600e3) }));
  assert.ok(rst(ui.btn));
  for (const provider of ['account:bigmodel-team-coding-plan', 'account:zai-team-coding-plan',
    'account:bigmodel-start-plan', 'account:zai-start-plan', 'bigmodel-api', 'bigmodel-api-2',
    'zai-api', 'zai-api-2', 'account:other', 'account:bigmodel', '', 'new-provider-ds']) {
    ui.marker.setAttribute('data-provider', provider);
    h.mutate(ui.pane);
    assert.equal(rst(ui.btn), undefined, provider + ' must not inherit a personal account badge');
  }
  ui.marker.setAttribute('data-provider', 'account:bigmodel-individual-coding-plan');
  h.mutate(ui.pane);
  assert.ok(rst(ui.btn));
});

test('missing or ambiguous live markers and session mismatch fail closed without using DB fallback', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  const p = payloadWithResets(h.payload, { bigmodel: rstEntry(3600e3) });
  p.provider_fallback = 'account:bigmodel-individual-coding-plan';
  h.window.__zusageUpdate(p);
  assert.ok(rst(ui.btn));
  ui.marker.remove();
  h.mutate(ui.pane);
  assert.equal(rst(ui.btn), undefined, 'removing a previously observed marker hides the badge');
  const marker = ui.card.appendChild(new Element('span'));
  marker.setAttribute('data-testid', 'v4-model-config');
  marker.setAttribute('data-provider', 'account:bigmodel-individual-coding-plan');
  marker.setAttribute('data-model', 'GLM-5.3');
  h.mutate(ui.pane);
  assert.ok(rst(ui.btn));
  const duplicate = ui.card.appendChild(new Element('span'));
  duplicate.setAttribute('data-testid', 'v4-model-config');
  duplicate.setAttribute('data-provider', 'account:bigmodel-individual-coding-plan');
  duplicate.setAttribute('data-model', 'GLM-5.3');
  h.mutate(ui.pane);
  assert.equal(rst(ui.btn), undefined, 'two candidate markers are ambiguous');
  duplicate.remove();
  h.mutate(ui.pane);
  assert.ok(rst(ui.btn));
  ui.pane.sid = 'sid_other';
  h.mutate(ui.pane);
  assert.equal(rst(ui.btn), undefined, 'marker for another session is not trusted');

  const old = harness(), legacy = old.buildComposer('workspace-main', 'sid_main');
  old.inject(); old.boot(); old.tick();
  const history = payloadWithResets(old.payload, { bigmodel: rstEntry(3600e3) });
  history.provider_fallback = 'account:bigmodel-individual-coding-plan';
  old.window.__zusageUpdate(history);
  assert.equal(rst(legacy.btn), undefined, 'older host without a pane marker must not use history');
  const oldPane = harness(), legacyPane = resetComposer(oldPane);
  legacyPane.marker.remove();
  oldPane.inject(); oldPane.boot(); oldPane.tick();
  const fallback = payloadWithResets(oldPane.payload, { bigmodel: rstEntry(3600e3) });
  fallback.provider_fallback = 'account:bigmodel-individual-coding-plan';
  oldPane.window.__zusageUpdate(fallback);
  assert.equal(rst(legacyPane.btn), undefined, 'older pane with no marker must not use history');
});

test('live marker decisions remain isolated by pane', () => {
  const h = harness(), a = resetComposer(h);
  const b = h.buildComposer('split-b', 'sid_b', { live: true, provider: 'new-provider-ds' });
  h.inject(); h.boot(); h.tick();
  const p = payloadWithResets(h.payload, { bigmodel: rstEntry(3600e3) });
  p.recent.push({ sid: 'sid_b', workspace_identity: '', ctx: 63400, context_window: 200000,
    last: { provider_id: 'account:bigmodel-individual-coding-plan' } });
  h.window.__zusageUpdate(p);
  assert.ok(rst(a.btn));
  assert.equal(rst(b.btn), undefined, 'third-party pane cannot borrow the other pane marker');
  b.marker.setAttribute('data-provider', 'account:zai-individual-coding-plan');
  h.mutate(b.pane);
  assert.ok(rst(b.btn));
  a.marker.setAttribute('data-provider', 'new-provider-ds');
  h.mutate(a.pane);
  assert.equal(rst(a.btn), undefined);
  assert.ok(rst(b.btn), 'switching one pane must not remove the other badge');
});

test('old main process without reset data removes an existing badge and tooltip', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(payloadWithResets(h.payload, { bigmodel: rstEntry(3600e3) }));
  rst(ui.btn).listeners.get('mouseenter')[0].call(rst(ui.btn));
  const tip = h.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.ok(tip);
  const old = h.payload();
  old.recent[0].last = { provider_id: 'account:bigmodel-individual-coding-plan' };
  old.quota = { sources: {} };
  h.window.__zusageUpdate(old);
  assert.equal(rst(ui.btn), undefined);
  assert.equal(tip.style.display, 'none');
  assert.equal(h.window.__zusageDiag.updateErr, undefined);
});

test('tooltip shows individual valid and recent expired cards, and hides badge when none remain', () => {
  const h = harness(), ui = resetComposer(h);
  h.inject(); h.boot(); h.tick();
  const now = Date.now();
  const entry = { count: 99, expireAt: now - 1000, fiveHour: [{ expireAt: now + 3600e3 }, { expireAt: now - 3600e3 }, { expireAt: now - 8 * 86400e3 }], week: [{ expireAt: now + 7200e3 }] };
  const p = payloadWithResets(h.payload, { bigmodel: entry });
  h.window.__zusageUpdate(p);
  const b = rst(ui.btn);
  assert.match(b.innerHTML, /<\/svg>2 · /);
  b.listeners.get('mouseenter')[0].call(b);
  const tip = h.body.children.find(e => e.className.indexOf('zusage-quota-tip') >= 0 && e.style.display === 'block');
  assert.equal((tip.innerHTML.match(/到期 /g) || []).length, 2);
  assert.equal((tip.innerHTML.match(/已过期 /g) || []).length, 1);
  entry.fiveHour = [{ expireAt: now - 3600e3 }]; entry.week = [];
  h.window.__zusageUpdate(p);
  assert.equal(rst(ui.btn), undefined);
});
