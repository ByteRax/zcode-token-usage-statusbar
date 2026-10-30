const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v146 精简模式速率 chip（.zu-tsb）：整 IIFE 执行 + instances 接缝（overlay-quota-chip 同款
 * 夹具）。夹具：输入卡片 group/toolbar 工具行放 wrapper span > button[chat-context-usage-trigger]，
 * localStorage 预置 zusage3.theme=compact，推带 last.tps 的 payload；断言 chip 挂载位置
 * （重置卡/额度组 wrapper 左侧）、DB 回退值与档位类、无数据隐藏、非精简主题门控摘除、
 * 签名幂等/位置兜回、tooltip 摘要行逐格开关、「打开设置」按钮开面板、dispose 清理。 */
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
    if (el === ref) return el;   // 自插=已就位（真实 DOM 为 no-op；桩走 remove+splice 会把条目塞回两次）
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
    if (sel === 'circle') return this.children.filter(e => e.tagName === 'CIRCLE').concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    if (sel === '.zu-sr-only') return this.children.filter(e => e.classList.contains('zu-sr-only')).concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    if (sel === '.it' || sel === '.zu-sub') return [];
    const m = /^\[(data-[a-z-]+|data-testid)(?:="([^"]*)")?\]$/.exec(sel);
    if (m) {   // gitMount 的前导区发现依赖属性选择器（v147 速率 chip 同源）
      const key = m[1], val = m[2];
      const hit = e => (val === undefined ? e.getAttribute(key) !== null : e.getAttribute(key) === val);
      return this.children.filter(hit).concat(
        ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    }
    return [];
  }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return k === 'data-pane-id' ? !!this.pid : k === 'data-session-id' ? !!this.sid : Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return k === 'data-pane-id' ? (this.pid || null) : k === 'data-session-id' ? (this.sid || null) : (this.dataset[k] !== undefined ? this.dataset[k] : null); }
  getBoundingClientRect() { return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 }; }
}

function harness({ theme = 'compact', show } = {}) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  const store = new Map([['zusage3.theme', theme]]);
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' }, localStorage,
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.tpsTest = { instances: function() { return instances; }, state: function() { return state; }, setBarTheme: function(t) { setBarTheme(t); } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function buildComposer(pid, sid, { leading = true } = {}) {
    const card = body.appendChild(new Element());
    const row = card.appendChild(new Element());
    row.className = 'group/toolbar flex items-end gap-3';
    let leadWrap = null, cua = null;
    if (leading) {   // v147：速率 chip 挂前导区（git chip 同款发现面）
      leadWrap = row.appendChild(new Element('span'));
      leadWrap.setAttribute('data-composer-leading-content', 'true');
      cua = leadWrap.appendChild(new Element('button'));
      cua.setAttribute('data-testid', 'v4-composer-cua-entry');
    }
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
    return { card, row, wrap, btn, editor, leadWrap, cua };
  }
  function payload({ tps } = {}) {
    const last = { provider_id: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-Flash' };
    if (tps !== undefined) last.tps = tps;
    return { remote_evidence: false, today: { total: 12000, requests: 4 }, not_local: [],
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
        last_turn: { total: 5200, requests: 2 }, last }] };
  }
  const chipOf = root => {
    const scan = e => {
      if (e.classList && e.classList.contains('zu-tsb')) return e;
      for (const c of e.children || []) { const hit = scan(c); if (hit) return hit; }
      return null;
    };
    return scan(root);
  };
  const barEl = () => body.children.find(e => /zusage-root/.test(e.className || ''));
  const tipEl = () => body.children.find(e => e.classList.contains('zusage-tps-tip'));
  const panelEl = () => body.children.find(e => e.classList.contains('zu-settings'));
  return { window, body, store, inject, tick, boot, buildComposer, payload, chipOf, barEl, tipEl, panelEl };
}

test('compact theme: tps chip mounts in the leading area, taking the git slot (after cua) when git is absent', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  const chip = h.chipOf(ui.row);
  assert.ok(chip, 'chip mounted');
  assert.equal(chip.parentElement, ui.leadWrap, 'chip lives in the leading content group (git chip home)');
  assert.equal(ui.cua.nextElementSibling, chip, 'git absent -> chip takes the git anchor slot right after the cua button');
  assert.equal(chip.innerHTML, '<span class="zu-live ok">87.3 t/s</span>', 'DB fallback renders value + unit with the 70-150 band class');
  assert.equal(chip.getAttribute('aria-label'), '生成速度 87.3 t/s');
  assert.ok(chip.tabIndex === 0, 'keyboard reachable');
});

test('git chip present: rate re-anchors before it ([cua][rate][git]); trailing fallback without leading content', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  const fakeGit = new Element('span');
  fakeGit.className = 'zu-git';
  ui.leadWrap.appendChild(fakeGit);   // git chip 后到：占锚位相邻（enhanceGitChip 的容忍规则）
  h.tick();
  const chip = h.chipOf(ui.row);
  assert.equal(chip.nextElementSibling, fakeGit, 'rate sits immediately before the git chip');
  assert.equal(ui.leadWrap.children.indexOf(ui.cua), 0, 'cua stays first');
  // 回退：无前导区（异形布局）→ 尾随区重置卡/额度组左侧（v146 原位）
  const fb = harness(), u1 = fb.buildComposer('workspace-main', 'sid_main', { leading: false });
  fb.inject(); fb.boot(); fb.tick();
  fb.window.__zusageUpdate(fb.payload({ tps: 87.3 }));
  const fchip = fb.chipOf(u1.row);
  assert.ok(fchip, 'fallback chip mounted');
  assert.equal(fchip.parentElement, u1.row, 'fallback host is the toolbar row');
  assert.equal(fchip.nextElementSibling, u1.wrap, 'fallback anchors left of the quota group wrapper');
});

test('no valid sample hides the chip (user decision); non-compact themes never mount it', () => {
  const none = harness(), u0 = none.buildComposer('workspace-main', 'sid_main');
  none.inject(); none.boot(); none.tick();
  none.window.__zusageUpdate(none.payload({}));
  none.tick();
  assert.equal(none.chipOf(u0.row), null, 'no tps -> no chip (settings entry gap accepted)');
  const def = harness({ theme: 'default' }), u1 = def.buildComposer('workspace-main', 'sid_main');
  def.inject(); def.boot(); def.tick();
  def.window.__zusageUpdate(def.payload({ tps: 87.3 }));
  def.tick();
  assert.equal(def.chipOf(u1.row), null, 'rate chip is compact-mode only');
});

test('content is signature-idempotent, re-anchors after being displaced, and updates on new data', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  let chip = h.chipOf(ui.row);
  chip.innerHTML += '<!--hover-state-->';
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  h.tick();
  assert.ok(chip.innerHTML.includes('<!--hover-state-->'), 'same signature leaves the DOM untouched');
  assert.equal(h.chipOf(ui.row), chip, 'no duplicate chip');
  // React 挤位：速率 chip 被挪到前导区末尾，heavy 对账兜回锚位（cua-entry 之后）
  const spacer = new Element('span');
  ui.leadWrap.insertBefore(spacer, ui.cua.nextElementSibling);   // [cua][spacer][...]
  ui.leadWrap.appendChild(chip);   // 挤到末尾
  h.tick();
  chip = h.chipOf(ui.row);
  assert.equal(chip.nextElementSibling, spacer, 'displaced chip is moved back right after the cua anchor');
  // 数据变化：签名变化重建内容
  h.window.__zusageUpdate(h.payload({ tps: 12.5 }));
  chip = h.chipOf(ui.row);
  assert.equal(chip.innerHTML, '<span class="zu-live hot">12.5 t/s</span>', 'new band class on new value');
});

test('tooltip: speed rows + bar summary gated by per-cell toggles + legend + settings button that opens the panel', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  const chip = h.chipOf(ui.row);
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl();
  assert.ok(tip && tip.style.display === 'block', 'tps tip shown');
  assert.ok(tip.innerHTML.includes('生成速度'), 'speed header');
  assert.ok(tip.innerHTML.includes('状态条摘要'), 'summary section');
  assert.ok(tip.innerHTML.includes('本轮'), 'turn summary row');
  assert.ok(tip.innerHTML.includes('会话累计'), 'session summary row');
  assert.ok(tip.innerHTML.includes('今日合计'), 'today summary row');
  assert.ok(tip.innerHTML.includes('颜色对照'), 'band legend');
  assert.ok(tip.innerHTML.includes('打开设置'), 'settings entry button');
  assert.ok(tip.innerHTML.includes('子代理'), 'sub-agent row');
  // 逐格开关继续生效（用户拍板）：关掉「本轮」后摘要行消失
  h.window.tpsTest.state().show.turn = 0;
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.ok(!tip.innerHTML.includes('本轮'), 'turn row disappears with the cell toggle');
  // 「打开设置」按钮：走 chip.__zuOpen 开设置面板
  const bar = h.barEl();
  const gear = bar.querySelector('.zu-gear');
  chip.listeners.get('mouseleave')[0].call(chip);   // 模拟移入 tooltip 前的桥（延迟收起）
  chip.listeners.get('mouseenter')[0].call(chip);
  const btnFake = { closest: sel => (sel === '.tps-cfg' ? { __isCfg: true } : null) };
  tip.listeners.get('click')[0]({ target: btnFake, stopPropagation() {} });
  const panel = h.panelEl();
  assert.ok(panel && panel.classList.contains('open'), 'settings panel opened from the tooltip');
  assert.equal(gear.getAttribute('aria-expanded'), 'true');
  // 子代理摘要行点击开明细面板（toggleSubPanel）
  const subFake = { closest: sel => (sel === '.tps-subrow' ? { __isSub: true } : null) };
  chip.listeners.get('mouseenter')[0].call(chip);
  tip.listeners.get('click')[0]({ target: subFake, stopPropagation() {} });
  const subp = h.body.children.find(e => e.classList.contains('subp'));
  assert.ok(subp && subp.classList.contains('open'), 'sub-agent details panel opened from the tooltip row');
});

test('dispose removes the chip; switching theme to default via setBarTheme removes it too', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  const chip = h.chipOf(ui.row);
  assert.ok(chip, 'chip mounted');
  h.window.tpsTest.setBarTheme('default');
  assert.equal(h.chipOf(ui.row), null, 'leaving compact removes the rate chip immediately');
  h.window.tpsTest.setBarTheme('compact');
  h.tick();
  const again = h.chipOf(ui.row);
  assert.ok(again && again !== undefined, 're-entering compact re-mounts');
  h.window.tpsTest.instances()[0].dispose();
  assert.equal(h.chipOf(ui.row), null, 'dispose cleans up the chip');
});
