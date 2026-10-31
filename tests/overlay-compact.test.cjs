const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v105 压缩上下文：整 IIFE 执行 + instances 接缝（overlay-quota-chip 同款夹具扩展）。
 * 夹具新增：body 直挂的 Radix hover-card portal（指纹 !w-80 + [data-slot=progress] +
 * div.space-y-3 容器，内含命中率行与「剩余额度」border-t 段）、可注册的 v4-composer-input
 * （E2E 输入桥桩）与 v4-composer-send。断言：指纹判别、插入位置与兜回、幂等、弹框开关
 * （Esc/遮罩/取消/Enter）、fiber 主通道 onSendCompressionCommand("/compact")、E2E 桥兜底、
 * 草稿拒绝、双通道皆缺报错、dispose 清理、英文文案。 */

const ZU_HC_SEL = '[data-slot="hover-card-content"]';

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
  dispatch(type, ev) { for (const fn of (this.listeners.get(type) || []).slice()) fn(Object.assign({ preventDefault() {}, stopPropagation() {}, currentTarget: this }, ev)); }
  click() { this.dispatch('click'); }
  focus() {}
  querySelector(k) {
    if (k === '[data-testid="chat-context-usage-trigger"]') {
      for (const c of this.children) {
        if (c.dataset && c.dataset['data-testid'] === 'chat-context-usage-trigger') return c;
        const hit = c.querySelector && c.querySelector(k);
        if (hit) return hit;
      }
      return null;
    }
    if (k === '[data-slot="progress"]') {   // 只认真实命中的节点：不落惰性空元素分支
      for (const c of this.children) {
        if (c.dataset && c.dataset['data-slot'] === 'progress') return c;
        const hit = c.querySelector && c.querySelector(k);
        if (hit && hit.dataset && hit.dataset['data-slot'] === 'progress') return hit;
      }
      return null;
    }
    if (k === 'div.space-y-3') {
      for (const c of this.children) if (String(c.className || '').split(/\s+/).includes('space-y-3')) return c;
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
    if (sel !== 'circle') return [];
    return this.children.filter(e => e.tagName === 'CIRCLE').concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
  }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return k === 'data-pane-id' ? !!this.pid : k === 'data-session-id' ? !!this.sid : Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return k === 'data-pane-id' ? (this.pid || null) : k === 'data-session-id' ? (this.sid || null) : (this.dataset[k] !== undefined ? this.dataset[k] : null); }
  getBoundingClientRect() {
    if (!this.isConnected) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };   // 失联（Radix 卸载）矩形全零
    return this._rect || { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 };
  }
}

function harness({ lang = 'zh' } = {}) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  window.__zusagePluginState = { quotaEnabled: true };
  let panes = [];
  const hoverCards = [];
  const document = new Element();
  const collect = pred => {
    const out = [];
    const walk = el => { for (const c of el.children) { if (pred(c)) out.push(c); walk(c); } };
    walk(body);
    return out;
  };
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    /* 文本节点桩须可被 collect 走到（真实 querySelectorAll 不返回文本节点，但本夹具的
     * 递归 walk 会进 children）：补 getAttribute/children 防谓词抛错。 */
    createTextNode: t => ({ textContent: t, children: [], getAttribute: () => null, contains: () => false }),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => {
      if (selector === ZU_HC_SEL) return hoverCards.filter(h => h.isConnected);
      if (selector.startsWith('textarea,')) return panes;
      const m = selector.match(/^\[data-testid="([^"]+)"\]$/);
      if (m) return collect(c => c.getAttribute('data-testid') === m[1]);
      return [];
    },
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' },
    localStorage: { getItem: k => (k === 'zusage3.lang' && lang === 'en' ? 'en' : null), setItem() {} },
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
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.compactTest = { instances: function() { return instances; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function pumpFrames() { for (const [n, f] of [...frames]) { frames.delete(n); f(); } }
  function buildComposer(pid, sid) {
    const card = body.appendChild(new Element());
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
    return { card, row, wrap, btn, editor };
  }
  /* v4-composer-input（E2E 输入桥）与发送键：compactSend 主通道的注册面；
   * stop=流式中 v4-stop 可见（应拒绝提交）。 */
  function buildSubmitChain({ bridge = true, draft = '', stop = false, sendDisabled = false } = {}) {
    const input = new Element('div');
    input.setAttribute('data-testid', 'v4-composer-input');
    const api = {
      text: draft,
      calls: [],
      getText() { return this.text; },
      setText(t) { this.calls.push(['setText', t]); this.text = t; },
    };
    if (bridge) {
      input.__zcodeLexicalInputE2E = api;
      input.setAttribute('data-e2e-lexical-bridge', 'ready');
    }
    const send = new Element('button');
    send.setAttribute('data-testid', 'v4-composer-send');
    send.disabled = sendDisabled;
    send.clicks = 0;
    send.click = () => { send.clicks += 1; };
    body.appendChild(input);
    body.appendChild(send);
    let stopBtn = null;
    if (stop) {
      stopBtn = new Element('button');
      stopBtn.setAttribute('data-testid', 'v4-stop');
      body.appendChild(stopBtn);
    }
    return { input, api, send, stopBtn };
  }
  /* 「上下文容量」弹层：hover-card-content（!w-80 + Progress 指纹）> ContextContentBody
   * （space-y-3）> 头部块 + 命中率行 + 可选「剩余额度」border-t 段。 */
  function buildHoverCard({ withBorderT = true, fingerprint = true } = {}) {
    const hc = new Element('div');
    hc.className = fingerprint
      ? 'z-50 w-72 !w-80 !rounded-xl !shadow-md'
      : 'z-50 w-72 rounded-xl shadow-md';
    const prog = hc.appendChild(new Element('div'));
    prog.setAttribute('data-slot', 'progress');
    const bodyEl = hc.appendChild(new Element('div'));
    bodyEl.className = 'w-full bg-menu p-3 space-y-3';
    const head = bodyEl.appendChild(new Element('div'));
    head.className = 'space-y-2';
    const cacheRow = bodyEl.appendChild(new Element('div'));
    cacheRow.className = 'flex items-center justify-between gap-3 text-ui-sm';
    let borderT = null;
    if (withBorderT) {
      borderT = bodyEl.appendChild(new Element('div'));
      borderT.className = 'border-t border-border pt-2';
    }
    hoverCards.push(hc);
    body.appendChild(hc);   // Radix portal 直挂 body
    return { hc, body: bodyEl, head, cacheRow, borderT };
  }
  const compactBtnOf = bodyEl => bodyEl.children.find(e => e.classList.contains('zu-compact-btn'));
  const dlgEl = () => body.children.find(e => e.classList.contains('zu-compact-dlg'));
  const findIn = (root, cls) => {
    for (const c of root.children) {
      if (c.classList && c.classList.contains(cls)) return c;
      const hit = c.children && c.children.length ? findIn(c, cls) : null;
      if (hit) return hit;
    }
    return null;
  };
  function mutateBody() { for (const o of [...observers]) if (o.connected && o.target === body) o.fn([]); }
  function keyDownLast() { const fns = document.listeners.get('keydown'); return fns && fns.length ? fns[fns.length - 1] : null; }
  return { window, document, body, inject, tick, boot, pumpFrames, buildComposer, buildSubmitChain, buildHoverCard,
    compactBtnOf, dlgEl, findIn, mutateBody, keyDownLast, observers, frames, hoverCards };
}

test('胶囊按钮注入在命中率行下、「剩余额度」段前，重复同步幂等', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  assert.ok(btn, 'button mounted');
  assert.equal(btn.textContent, '压缩上下文');
  assert.equal(ui.body.children.indexOf(btn), ui.body.children.indexOf(ui.borderT) - 1);
  h.tick();
  assert.equal(h.compactBtnOf(ui.body), btn, 'idempotent: 同一颗按钮不被重建');
  assert.equal(ui.body.children.filter(e => e.classList.contains('zu-compact-btn')).length, 1);
});

test('无「剩余额度」段时按钮落在容器尾（仍是命中率行下方）', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: false });
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  assert.ok(btn);
  assert.equal(ui.body.children[ui.body.children.length - 1], btn);
});

test('指纹判别：缺 !w-80 或缺 Progress 的 hover-card 一律不注入', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const noWidth = h.buildHoverCard({ fingerprint: false });
  const h2 = harness();
  h2.buildComposer('workspace-main', 'sid_main');
  const hc2 = new Element('div');
  hc2.className = '!w-80';
  hc2.appendChild(new Element('div'));   // 无 Progress
  const body2 = hc2.appendChild(new Element('div'));
  body2.className = 'w-full bg-menu p-3 space-y-3';
  h2.hoverCards.push(hc2); h2.body.appendChild(hc2);
  h.inject(); h.boot(); h.tick();
  h2.inject(); h2.boot(); h2.tick();
  assert.equal(h.compactBtnOf(noWidth.body), undefined);
  assert.equal(h2.compactBtnOf(body2), undefined);
});

test('「剩余额度」段迟到出现时按钮位置兜回其上方（MutationObserver 即时触发）', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  assert.ok(btn);
  /* 模拟 React 在命中率行与按钮之间插入新 pt-2 段（额度数据刷新时「剩余额度」另一段先出现）：
   * 按钮被挤离锚点（首个 border-t+pt-2 段），下一轮同步应兜回该段上方。 */
  const newSec = ui.body.insertBefore(new Element('div'), btn);
  newSec.className = 'border-t border-border pt-2';
  assert.equal(ui.body.children.indexOf(newSec), ui.body.children.indexOf(btn) - 1, '前置：新段插在按钮前');
  h.mutateBody();          // v105 观察器路径（body 级）
  h.pumpFrames();          // rAF 去抖后执行 syncCompactBtn
  assert.equal(ui.body.children.indexOf(btn), ui.body.children.indexOf(newSec) - 1, '兜回首个 pt-2 段上方');
  assert.equal(ui.body.children.indexOf(newSec), ui.body.children.indexOf(ui.borderT) - 1);
});

test('命中率行自带 border-t（breakdown 存在时 pt-3）不充当锚点，按钮仍在其下方', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  ui.cacheRow.className = 'flex items-center justify-between gap-3 text-ui-sm border-t border-border pt-3';
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  assert.ok(btn);
  assert.equal(ui.body.children.indexOf(ui.cacheRow), ui.body.children.indexOf(btn) - 1);
  assert.equal(ui.body.children.indexOf(btn), ui.body.children.indexOf(ui.borderT) - 1);
});

test('点击开确认框：标题/用量行/双语按钮齐全，Esc、遮罩、取消均可关闭', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  btn.dispatch('click');
  let dlg = h.dlgEl();
  assert.ok(dlg, 'dialog opened');
  assert.equal(h.findIn(dlg, 'zu-compact-title').textContent, '压缩上下文');
  const usage = h.findIn(dlg, 'zu-compact-desc').children[0];
  assert.equal(usage.textContent, '当前已用 63,400 / 总量 200,000');
  const ok = h.findIn(dlg, 'zu-compact-ok');
  const cancel = h.findIn(dlg, 'zu-compact-cancel');
  assert.equal(ok.textContent, '压缩');
  assert.equal(cancel.textContent, '取消');
  const hint = h.findIn(dlg, 'zu-compact-hint');
  assert.match(hint && hint.textContent, /请勿发送新消息/);
  const esc = h.keyDownLast();
  assert.ok(esc, 'Esc capture listener registered');
  esc({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.dlgEl(), undefined, 'Esc closes');
  assert.equal(h.keyDownLast(), null, 'keydown 监听随关闭解绑');
  btn.dispatch('click');
  h.findIn(h.dlgEl(), 'zu-compact-cancel').dispatch('click');
  assert.equal(h.dlgEl(), undefined, 'cancel closes');
  btn.dispatch('click');
  const dlg3 = h.dlgEl();
  dlg3.dispatch('mousedown', { target: dlg3 });   // 点遮罩（target===dlg）
  assert.equal(h.dlgEl(), undefined, 'backdrop closes');
  assert.equal(h.keyDownLast(), null, 'keydown 监听随关闭解绑');
});

test('主通道（v109）：直接调 fiber 命令信封 onSendCompressionCommand("/compact")，Enter 亦可确认', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  const sent = [];
  comp.btn['__reactFiber$fixture'] = { memoizedProps: { onSendCompressionCommand: cmd => { sent.push(cmd); } }, return: null };
  const submit = h.buildSubmitChain({ bridge: true, draft: '草稿不应被动' });
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  btn.dispatch('click');
  const ok = h.findIn(h.dlgEl(), 'zu-compact-ok');
  ok.dispatch('click');
  assert.deepEqual(sent, ['/compact']);
  assert.equal(h.dlgEl(), undefined, '成功后弹框关闭');
  assert.deepEqual(submit.api.calls, [], '主通道不碰输入框');
  assert.equal(submit.send.clicks, 0);
  assert.deepEqual(submit.api.text, '草稿不应被动');
  btn.dispatch('click');
  const enter = h.keyDownLast();
  assert.ok(enter, 'Enter 确认监听在位');
  enter({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(sent, ['/compact', '/compact'], 'Enter 确认同链路');
  assert.equal(h.dlgEl(), undefined);
});

test('流式中（v4-stop 可见）拒绝提交，不写输入框', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  const submit = h.buildSubmitChain({ bridge: true, stop: true });
  h.inject(); h.boot(); h.tick();
  h.compactBtnOf(ui.body).dispatch('click');
  const ok = h.findIn(h.dlgEl(), 'zu-compact-ok');
  ok.dispatch('click');
  const err = h.findIn(h.dlgEl(), 'zu-compact-err');
  assert.ok(err.classList.contains('on'));
  assert.match(err.textContent, /正在生成回复/);
  assert.deepEqual(submit.api.calls, []);
  assert.equal(submit.send.clicks, 0);
  assert.ok(h.dlgEl(), '弹框保留');
});

test('发送键禁用拒绝提交（门控前置：输入框不被写入）', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  const submit = h.buildSubmitChain({ bridge: true, sendDisabled: true });
  h.inject(); h.boot(); h.tick();
  h.compactBtnOf(ui.body).dispatch('click');
  const ok = h.findIn(h.dlgEl(), 'zu-compact-ok');
  ok.dispatch('click');
  const err = h.findIn(h.dlgEl(), 'zu-compact-err');
  assert.match(err.textContent, /发送键当前不可用/);
  assert.deepEqual(submit.api.calls, [], '拒绝发生在 setText 之前，不残留草稿');
  assert.equal(submit.send.clicks, 0);
  assert.ok(h.dlgEl());
});

test('fiber 缺失回落字面 "/compact"：setText + 发送键', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  const submit = h.buildSubmitChain({ bridge: true, draft: '' });
  h.inject(); h.boot(); h.tick();
  h.compactBtnOf(ui.body).dispatch('click');
  h.findIn(h.dlgEl(), 'zu-compact-ok').dispatch('click');
  assert.deepEqual(submit.api.calls, [['setText', '/compact']]);
  assert.equal(submit.send.clicks, 1);
  assert.equal(h.dlgEl(), undefined);
});

test('兜底通道遇未发送草稿一律拒绝，弹框保留并显示错误', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  const submit = h.buildSubmitChain({ bridge: true, draft: '还没发完的草稿' });
  h.inject(); h.boot(); h.tick();
  h.compactBtnOf(ui.body).dispatch('click');
  const ok = h.findIn(h.dlgEl(), 'zu-compact-ok');
  ok.dispatch('click');
  const err = h.findIn(h.dlgEl(), 'zu-compact-err');
  assert.ok(err && err.classList.contains('on'), '错误文案显示');
  assert.match(err.textContent, /草稿/);
  assert.deepEqual(submit.api.calls, [], '不清写输入框');
  assert.equal(submit.send.clicks, 0);
  assert.ok(h.dlgEl(), '弹框不静默关闭');
});

test('双通道皆缺：中性报错不发送', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  const submit = h.buildSubmitChain({ bridge: false });
  h.inject(); h.boot(); h.tick();
  h.compactBtnOf(ui.body).dispatch('click');
  const ok = h.findIn(h.dlgEl(), 'zu-compact-ok');
  ok.dispatch('click');
  const err = h.findIn(h.dlgEl(), 'zu-compact-err');
  assert.ok(err.classList.contains('on'));
  assert.match(err.textContent, /提交通道/);
  assert.deepEqual(submit.api.calls, []);
  assert.equal(submit.send.clicks, 0);
  assert.ok(h.dlgEl());
});

test('dispose：弹框与 keydown 监听一并摘除，body 观察器断开，残留按钮点击失效', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  btn.dispatch('click');
  assert.ok(h.dlgEl());
  const inst = h.window.compactTest.instances()[0];
  inst.dispose();
  assert.equal(h.dlgEl(), undefined, '弹框随 dispose 摘除');
  const bodyObs = h.observers.find(o => o.target === h.body);
  assert.ok(bodyObs && !bodyObs.connected, 'body 观察器断开');
  btn.dispatch('click');   // 新代际清扫前的残留按钮：无声失效
  assert.equal(h.dlgEl(), undefined);
});

test('多分栏：确认时弹层已卸载（锚点失联）仍按打开时解析的 pane 提交', () => {
  const h = harness();
  const left = h.buildComposer('workspace-left', 'sid_left');
  const right = h.buildComposer('workspace-right', 'sid_right');
  const ui = h.buildHoverCard({ withBorderT: true });
  const sentL = [], sentR = [];
  left.btn['__reactFiber$fx'] = { memoizedProps: { onSendCompressionCommand: c => sentL.push(c) }, return: null };
  right.btn['__reactFiber$fx'] = { memoizedProps: { onSendCompressionCommand: c => sentR.push(c) }, return: null };
  left.btn._rect = { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 };
  right.btn._rect = { top: 600, bottom: 650, left: 800, right: 1300, width: 500, height: 50 };
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  btn._rect = { top: 600, bottom: 650, left: 800, right: 1300, width: 500, height: 50 };   // 右栏弹层里的按钮
  btn.dispatch('click');
  btn.remove();   // 指针移入弹框 → Radix 关闭并卸载弹层：确认时锚点已失联（v110 前在此几何退化）
  h.findIn(h.dlgEl(), 'zu-compact-ok').dispatch('click');
  assert.deepEqual(sentR, ['/compact'], '打开瞬间缓存的右栏提交函数被调用');
  assert.deepEqual(sentL, [], '左栏不被误发（v110 前此处会收到 /compact）');
  assert.equal(h.dlgEl(), undefined);
});

test('焦点逸出弹框后 Enter 不劫持宿主，Esc 仍可关闭', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  const sent = [];
  comp.btn['__reactFiber$fx'] = { memoizedProps: { onSendCompressionCommand: c => sent.push(c) }, return: null };
  h.inject(); h.boot(); h.tick();
  h.compactBtnOf(ui.body).dispatch('click');
  h.document.activeElement = comp.editor;   // Tab 逸出：焦点落在弹框外
  const enter = h.keyDownLast();
  enter({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(sent, [], '焦点在弹框外：Enter 不触发确认');
  assert.ok(h.dlgEl(), '弹框仍开');
  const esc = h.keyDownLast();
  esc({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.dlgEl(), undefined, 'Esc 关闭不受焦点影响');
});

test('英文语言：按钮与弹框文案走 en 分支', () => {
  const h = harness({ lang: 'en' });
  const comp = h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  const sent = [];
  comp.btn['__reactFiber$fixture'] = { memoizedProps: { onSendCompressionCommand: cmd => { sent.push(cmd); } }, return: null };
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  assert.equal(btn.textContent, 'Compact context');
  btn.dispatch('click');
  assert.equal(h.findIn(h.dlgEl(), 'zu-compact-title').textContent, 'Compact context');
  const usage = h.findIn(h.dlgEl(), 'zu-compact-desc').children[0];
  assert.equal(usage.textContent, 'Used 63,400 of 200,000');
  assert.equal(h.findIn(h.dlgEl(), 'zu-compact-ok').textContent, 'Compact');
  h.findIn(h.dlgEl(), 'zu-compact-ok').dispatch('click');
  assert.deepEqual(sent, ['/compact']);
});

test('源码契约：冷启动清扫与新类名/观察器接线齐备', () => {
  assert.match(source, /\.zu-compact-btn,\.zu-ac-info,\.zu-compact-dlg/);   // 冷启动清扫选择器（v179 阈值行同 swept）
  assert.match(source, /hcObserver\.observe\(document\.body/);
  assert.match(source, /syncCompactBtn\(\);\s*\/\/ v105/);   // heavy 对账点
  assert.match(source, /onSendCompressionCommand/);
  assert.match(source, /__zcodeLexicalInputE2E/);
  assert.match(source, /data-e2e-lexical-bridge/);
});

test('v179 阈值行：补丁生效时钉在按钮之后，推送变化原地改字，未生效即摘除', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.window.__zusagePluginState.enginePatch = { enabled: true, state: 'applied', build: '3.17.1', config: { enabled: true, thresholdPercent: 70 } };
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  assert.ok(btn);
  const info = ui.body.children.find(e => e.classList.contains('zu-ac-info'));
  assert.ok(info, 'info row mounted');
  assert.equal(ui.body.children.indexOf(info), ui.body.children.indexOf(btn) - 1, 'v189：钉在压缩按钮上方');
  const infoText = info.children.find(e => e.classList && e.classList.contains('zu-ac-text'));
  assert.ok(infoText, '文本 span 存在');
  assert.match(infoText.textContent, /自动压缩 ~63%/);      // (200000−21000)×70% = 125,300 → 62.65% ≈ 63%
  assert.match(infoText.textContent, /125,300 token/);
  const link = info.children.find(e => e.classList && e.classList.contains('zu-ac-link'));
  assert.ok(link, '下划线「调整」链接存在');
  assert.equal(link.textContent, '调整');
  h.tick();
  assert.equal(ui.body.children.find(e => e.classList.contains('zu-ac-info')), info, '幂等：同一颗行不被重建');
  assert.equal(info.children.find(e => e.classList && e.classList.contains('zu-ac-link')), link, '链接不被重建（文本单独更新）');
  h.window.__zusagePluginUpdate({ enginePatch: { enabled: true, state: 'applied', build: '3.17.1', config: { enabled: false } } });
  h.tick();
  assert.equal(ui.body.children.find(e => e.classList.contains('zu-ac-info')), info, '原地更新不重建');
  assert.match(info.children.find(e => e.classList && e.classList.contains('zu-ac-text')).textContent, /已禁用/);
  assert.equal(info.children.find(e => e.classList && e.classList.contains('zu-ac-link')), link, '原地更新后链接仍在');
  h.window.__zusagePluginUpdate({ enginePatch: { enabled: true, state: 'unsupported_build', build: null } });
  h.tick();
  assert.ok(!ui.body.children.find(e => e.classList.contains('zu-ac-info')), '补丁未生效即摘除');
});

test('v189「调整」链接：点击打开 ⚙ 面板（复用 gear 路径），重复点击不炸', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.window.__zusagePluginState.enginePatch = { enabled: true, state: 'applied', build: '3.17.1', config: { enabled: true, thresholdPercent: 70 } };
  h.inject(); h.boot(); h.tick();
  const info = ui.body.children.find(e => e.classList.contains('zu-ac-info'));
  const link = info.children.find(e => e.classList.contains('zu-ac-link'));
  link.dispatch('click');
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  assert.ok(panel, '设置面板元素存在');
  assert.equal(panel.classList.contains('open'), true, '点击后面板打开（gear 路径）');
  link.dispatch('click');   // 面板已开时重复点击：不重复走打开分支，不应抛错
  assert.equal(panel.classList.contains('open'), true);
});

test('v179 阈值行：enginePatch 缺失（旧主进程）不渲染', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.inject(); h.boot(); h.tick();
  assert.ok(h.compactBtnOf(ui.body));
  assert.ok(!ui.body.children.find(e => e.classList.contains('zu-ac-info')));
});
