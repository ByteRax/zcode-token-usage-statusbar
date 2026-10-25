const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
    this.style.setProperty = (k, v) => { this.style[k] = v; };
    this.style.getPropertyValue = k => this.style[k] || '';
    this.listeners = new Map(); this.queries = new Map(); this.classes = new Set();
    this.classList = { contains: k => this.classes.has(k), add: k => this.classes.add(k), remove: k => this.classes.delete(k),
      toggle: (k, on) => { if (on) this.classes.add(k); else this.classes.delete(k); } };
    this.textContent = ''; this.innerHTML = ''; this.attributes = []; this.isConnected = true;
  }
  setAttribute(k, v) { this.dataset[k] = String(v); }
  removeAttribute(k) { delete this.dataset[k]; }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  count() { return [...this.listeners.values()].reduce((a, b) => a + b.length, 0); }
  appendChild(el) { this.children.push(el); el.parentElement = this; return el; }
  insertBefore(el, ref) {   // v80 in-card 挂载依赖；ref 不属于本节点时按真实 DOM 语义退化为 append
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    const idx = this.children.indexOf(ref);
    if (el.parentElement) el.remove();
    this.children.splice(idx, 0, el);
    el.parentElement = this;
    return el;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.isConnected = false; }
  querySelector(k) { if (!this.queries.has(k)) this.queries.set(k, new Element()); return this.queries.get(k); }
  querySelectorAll() { return []; }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return k === 'data-pane-id' ? !!this.pid : k === 'data-session-id' ? !!this.sid : Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return k === 'data-pane-id' ? this.pid : k === 'data-session-id' ? this.sid : this.dataset[k] ?? null; }
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
    MutationObserver: class { constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); } observe() { this.connected = true; } disconnect() { this.connected = false; } },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.lifecycleTest = { instances: function() { return instances; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && t.ms === 600) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function setPanes(keys, opts = {}) {
    panes = keys.map(k => { const card = body.appendChild(new Element()); card.style.marginBottom = k + 'px';
      const e = card.appendChild(new Element('textarea')); e.pid = k; e.sid = 'sid_' + k;
      if (opts.toolbar) {   // v80 in-card 夹具：宿主卡片最后一个子块是 group/toolbar 工具行
        const row = card.appendChild(new Element());
        row.className = 'group/toolbar flex items-end gap-3';
      }
      return e; });
    return panes.map(e => e.parentElement);
  }
  return { window, document, root, body, timers, frames, observers, inject, tick, boot, setPanes,
    runFrame() { for (const [n, fn] of [...frames]) fn(); } };
}

test('coordinator quota counts only live panes and handles more than four sequential IDs', () => {
  const h = harness(); h.setPanes(['a', 'b', 'c', 'd', 'overflow']); h.inject(); h.boot();
  assert.equal(h.window.lifecycleTest.instances().length, 4);
  assert.equal(h.frames.size, 4);
  const old = [...h.window.lifecycleTest.instances()];
  h.setPanes(['e', 'f', 'g', 'h']); h.tick();
  assert.deepEqual(Array.from(h.window.lifecycleTest.instances(), e => e.pid), ['e', 'f', 'g', 'h']);
  assert.equal(h.frames.size, 4);
  /* v105 起每实例两个常连观察器：theme + 弹层压缩按钮的 body 观察器（4 实例 × 2）。 */
  assert.equal(h.observers.filter(e => e.connected).length, 8);
  old.forEach(e => e.dispose());
  assert.equal(h.frames.size, 4);
  h.window.__zusageDispose();
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.document.count() + h.window.count() + h.root.count(), 0);
  assert.equal(h.observers.filter(e => e.connected).length, 0);
  assert.equal(h.body.children.filter(e => /zusage/.test(e.className || '')).length, 0);
});

test('padding release touches only the owning card and dispose restores original margins', () => {
  const h = harness(), cards = h.setPanes(['a', 'b']); h.inject(); h.boot();
  assert.equal(cards[0].style.marginBottom, '24px'); assert.equal(cards[1].style.marginBottom, '24px');
  h.window.lifecycleTest.instances()[0].dispose();
  assert.equal(cards[0].style.marginBottom, 'apx'); assert.equal(cards[1].style.marginBottom, '24px');
  h.window.__zusageDispose(); assert.equal(cards[1].style.marginBottom, 'bpx');
});

test('v80 in-card mount: bar lands inside the card after the toolbar row, no pad, no fixed styles', () => {
  const h = harness(), cards = h.setPanes(['a', 'b'], { toolbar: true }); h.inject(); h.boot();
  const [barA] = cards[0].children.filter(e => /zusage-root/.test(e.className || ''));
  const [barB] = cards[1].children.filter(e => /zusage-root/.test(e.className || ''));
  assert.ok(barA && barB, '两条分别挂进各自卡片');
  assert.equal(barA.classList.contains('zu-in'), true, 'in-card 形态类已加');
  assert.notEqual(barA.style.position, 'fixed', '内联 fixed 已摘除');
  assert.equal(cards[0].style.marginBottom, 'apx', 'in-card 形态不加 24px 让位带');
  // 位置：工具行之后（末尾无后续节点时 append 同语义）
  assert.equal(cards[0].children.indexOf(barA) > cards[0].children.findIndex(e => /group\/toolbar/.test(e.className || '')), true);
  // React 整子树重挂兜底（两条路径）：帧级对账（track/rAF）与周期对账（heavy/600ms）
  barA.remove();
  h.runFrame();
  assert.equal(barA.parentElement, cards[0], 'track 帧对账重挂回卡片');
  assert.equal(barA.classList.contains('zu-in'), true);
  barA.remove();
  h.tick();
  assert.equal(barA.parentElement, cards[0], 'heavy 周期对账兜底同样重挂');
  h.window.lifecycleTest.instances()[0].dispose();
  assert.equal(cards[0].children.includes(barA), false, 'dispose 从卡片摘除');
  h.window.__zusageDispose();
  assert.equal(cards[1].children.includes(barB), false);
});

test('reinjection and repeated cleanup cancel old loops and leave one live generation', () => {
  const h = harness(); h.setPanes(['a']); h.inject(); h.boot();
  const cleanup = h.window.__zusageDispose;
  h.inject(); h.boot(); cleanup();
  assert.equal(h.frames.size, 1); assert.equal(h.observers.filter(e => e.connected).length, 2);   // v105：theme + 弹层压缩按钮 body 观察器
  // 5 = coordinator(600) + heavy(600) + rateScan(2s) + deterministic scan(2s) + per-pane bridge probe(2s)
  assert.equal(h.timers.size, 5);
  h.window.__zusageDispose(); cleanup();
  assert.equal(h.timers.size, 0); assert.equal(h.frames.size, 0);
  assert.deepEqual(Array.from(h.window.__zusageWantSids), []); assert.equal(h.window.__zusageWantSid, '');
});

test('node scope changes with the same sid are reflected by the live instance immediately', () => {
  const h = harness(), [card] = h.setPanes(['workspace-main']);
  const composer = card.children[0], A = 'remote:ssh:a:22:u:/p', B = 'remote:ssh:b:22:u:/p';
  Object.assign(composer.dataset, {
    'data-zusage-scope-version': '1', 'data-zusage-pane-id': 'workspace-main',
    'data-zusage-workspace-path': '/p', 'data-zusage-workspace-identity': A,
    'data-zusage-remote-session-id': 'connectionA',
  });
  h.inject(); h.boot();
  const inst = h.window.lifecycleTest.instances()[0];
  assert.equal(inst.getScope().identity, A);
  assert.equal(h.window.__zusagePaneScopes['workspace-main'].identity, A);
  composer.dataset['data-zusage-workspace-identity'] = B;
  composer.dataset['data-zusage-remote-session-id'] = 'connectionB';
  assert.equal(inst.getScope().identity, B);
  h.tick();
  assert.equal(h.window.__zusagePaneScopes['workspace-main'].identity, B);
  delete composer.dataset['data-zusage-scope-version'];
  assert.equal(inst.getScope(), null);
  h.tick();
  assert.equal(h.window.__zusagePaneScopes['workspace-main'].identity, undefined);
  composer.isConnected = false;
  assert.equal(inst.getScope(), null);
  h.window.__zusageDispose();
});

test('empty main document actually creates the auto shadow/iframe fallback instance', () => {
  const h = harness(); h.inject(); h.boot();
  assert.equal(h.window.lifecycleTest.instances().length, 1);
  assert.equal(h.window.lifecycleTest.instances()[0].pid, 'auto');
  h.window.__zusageDispose();
});

// v91：设置是同窗口覆盖层，MCP 服务器表单的「请求头」textarea 在下半屏正常可见、
// 不是幽灵也不在弹窗里，v61/v62 判定拦不住——必须按设置页标记（PR #44 收尾后为
// 三层并集：settings-page testid + content/panel 双 frame）祖先排除，否则协调器
// 派实例、条挂进表单卡片（用户实测）。
test('settings-page form textarea is not dispatched or mounted as a chat composer', () => {
  const marker = k => /\[data-testid="settings-page"\]|\[data-settings-(content|panel)-frame\]/.test(k);
  // 只有设置表单编辑框（无 pane 标记）：不派发、不挂条
  const a = harness();
  const [layerA] = a.setPanes(['form']);
  const taA = layerA.children[0];
  taA.pid = undefined; taA.sid = undefined;
  taA.closest = k => marker(k) ? layerA : null;
  a.inject(); a.boot(); a.tick(); a.runFrame();
  assert.deepEqual(Array.from(a.window.lifecycleTest.instances(), e => e.pid), ['auto']);
  const barA = a.body.children.find(e => /zusage-root/.test(e.className || ''));
  assert.ok(barA, '兜底实例的条存在');
  assert.equal(barA.style.display, 'none', '设置表单编辑框不当聊天输入框，条保持隐藏');
  a.window.__zusageDispose();
  // 真 pane + 设置表单编辑框并存：pane 正常派发挂条，表单编辑框被排除
  const b = harness();
  const [, layerB] = b.setPanes(['workspace-main', 'form']);
  const taB = layerB.children[0];
  taB.pid = undefined; taB.sid = undefined;
  taB.closest = k => marker(k) ? layerB : null;
  b.inject(); b.boot(); b.tick(); b.runFrame();
  assert.deepEqual(Array.from(b.window.lifecycleTest.instances(), e => e.pid), ['workspace-main']);
  const barB = b.body.children.find(e => /zusage-root/.test(e.className || ''));
  assert.ok(barB, 'pane 实例的条存在');
  assert.equal(barB.style.display, 'flex', '真聊天输入框的条正常显示');
  b.window.__zusageDispose();
});
