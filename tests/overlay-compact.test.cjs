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

function harness({ lang = 'zh', ls = null } = {}) {
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
  const lsWrites = {};   // localStorage.setItem 的落账（setItem 桩只记录不抛）
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///Applications/ZCode.app/Contents/Resources/app.asar/out/renderer/index.html' },
    localStorage: { getItem: k => (k === 'zusage3.lang' && lang === 'en' ? 'en' : (ls && ls[k] != null ? ls[k] : null)), setItem: (k, v) => { lsWrites[k] = String(v); } },
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
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.compactTest = { instances: function() { return instances; }, state: function() { return state; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function flushTimeouts(msMatch) { for (const [n, t] of [...timers]) if (!t.interval && (msMatch == null || t.ms === msMatch)) { timers.delete(n); t.fn(); } }
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
   * （space-y-3）> 头部块 + 可选分项构成块（breakdown）+ 命中率行 + 可选「剩余额度」border-t 段。 */
  function buildHoverCard({ withBorderT = true, fingerprint = true, breakdown = null } = {}) {
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
    let bkdWrap = null, bkdGrid = null, bkdRows = [];
    if (Array.isArray(breakdown) && breakdown.length) {
      bkdWrap = bodyEl.appendChild(new Element('div'));
      bkdWrap.className = 'space-y-1.5';
      bkdWrap.setAttribute('aria-label', lang === 'en' ? 'Context sources' : '上下文来源');
      bkdGrid = bkdWrap.appendChild(new Element('div'));
      bkdGrid.className = 'grid gap-1.5';
      for (const item of breakdown) {
        const row = bkdGrid.appendChild(new Element('div'));
        row.className = 'flex min-w-0 items-center gap-2 text-ui-sm';
        const dot = row.appendChild(new Element('span'));
        dot.className = 'size-2 shrink-0 rounded-sm border border-border';
        const lbl = row.appendChild(new Element('span'));
        lbl.className = 'min-w-0 truncate text-foreground-subtle';
        lbl.textContent = item.label;
        const pct = row.appendChild(new Element('span'));
        pct.className = 'ml-auto min-w-10 shrink-0 text-right font-mono text-ui-sm tabular-nums text-foreground';
        pct.textContent = item.pct;
        bkdRows.push({ row, dot, lbl, pct });
      }
    }
    const cacheRow = bodyEl.appendChild(new Element('div'));
    cacheRow.className = 'flex items-center justify-between gap-3 text-ui-sm';
    const cacheLbl = cacheRow.appendChild(new Element('span'));
    cacheLbl.className = 'text-foreground-subtle';
    cacheLbl.textContent = lang === 'en' ? 'Average cache hit rate' : '平均缓存命中率';
    const cacheVal = cacheRow.appendChild(new Element('span'));
    cacheVal.className = 'font-mono text-ui-sm text-foreground';
    cacheVal.textContent = '95.4%';
    let borderT = null;
    if (withBorderT) {
      borderT = bodyEl.appendChild(new Element('div'));
      borderT.className = 'border-t border-border pt-2';
    }
    hoverCards.push(hc);
    body.appendChild(hc);   // Radix portal 直挂 body
    return { hc, body: bodyEl, head, bkdWrap, bkdGrid, bkdRows, cacheRow, borderT };
  }
  const compactBtnOf = bodyEl => bodyEl.children.find(e => e.classList.contains('zu-compact-btn'));
  const dlgEl = () => body.children.find(e => e.classList.contains('zu-compact-dlg'));
  const bkdTipEl = () => body.children.find(e => e.classList.contains('zusage-ctx-bkd-tip'));
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
  return { window, document, body, inject, tick, boot, flushTimeouts, pumpFrames, buildComposer, buildSubmitChain, buildHoverCard,
    compactBtnOf, dlgEl, bkdTipEl, findIn, mutateBody, keyDownLast, observers, frames, hoverCards, lsWrites };
}

test('胶囊按钮注入在命中率行下、「剩余额度」段前，重复同步幂等', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  assert.ok(btn, 'button mounted');
  /* v316 图标+文字组合：innerHTML 常量串不进 VM 桩 DOM，文案以 textNode 挂 children
   * （夹具桩的 children 含文本节点、textContent 是普通属性不聚合，故从 children 读）；
   * 真实浏览器要用 childNodes（children 只含元素节点），svg 无文本节点，语义一致。 */
  assert.equal(btn.children.map(c => c.textContent).join(''), '压缩上下文');
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
  const extBtn = ui.body.children.find(e => e.classList.contains('zu-ext-ctx-btn'));
  assert.ok(extBtn);
  assert.equal(ui.body.children[ui.body.children.length - 2], extBtn);
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
  const extBtn = ui.body.children.find(e => e.classList.contains('zu-ext-ctx-btn'));
  assert.equal(ui.body.children.indexOf(ui.cacheRow), ui.body.children.indexOf(extBtn) - 1);
  assert.equal(ui.body.children.indexOf(extBtn), ui.body.children.indexOf(btn) - 1);
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
  /* v339 起实例常驻 tipGlobalEsc 也在 document keydown 上（issue #297），
   * 「最后一个监听器为 null」不再成立——改断言 compactDlgKey 本身已解绑 */
  const keydownFns = () => h.document.listeners.get('keydown') || [];
  assert.ok(!keydownFns().includes(esc), 'keydown 监听随关闭解绑');
  btn.dispatch('click');
  h.findIn(h.dlgEl(), 'zu-compact-cancel').dispatch('click');
  assert.equal(h.dlgEl(), undefined, 'cancel closes');
  btn.dispatch('click');
  const dlg3 = h.dlgEl();
  dlg3.dispatch('mousedown', { target: dlg3 });   // 点遮罩（target===dlg）
  assert.equal(h.dlgEl(), undefined, 'backdrop closes');
  assert.ok(!keydownFns().includes(esc), 'keydown 监听随关闭解绑');
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
  const bodyObs = h.observers.filter(o => o.target === h.body);
  assert.ok(bodyObs.length >= 2, '实例弹框 body 观察器与 v486 文档级「在 Finder 中打开」观察器并存');
  assert.ok(!bodyObs[bodyObs.length - 1].connected, 'body 观察器断开');
  assert.ok(bodyObs[0].connected, 'v486 文档级观察器归代际所有，实例 dispose 不摘除（全局 __zusageDispose 才摘）');
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
  assert.equal(btn.children.map(c => c.textContent).join(''), 'Compact context');
  btn.dispatch('click');
  assert.equal(h.findIn(h.dlgEl(), 'zu-compact-title').textContent, 'Compact context');
  const usage = h.findIn(h.dlgEl(), 'zu-compact-desc').children[0];
  assert.equal(usage.textContent, 'Used 63,400 of 200,000');
  assert.equal(h.findIn(h.dlgEl(), 'zu-compact-ok').textContent, 'Compact');
  h.findIn(h.dlgEl(), 'zu-compact-ok').dispatch('click');
  assert.deepEqual(sent, ['/compact']);
});

test('源码契约：冷启动清扫与新类名/观察器接线齐备', () => {
  assert.match(source, /\.zu-compact-btn,\.zu-ac-info,\.zu-ac-hint,\.zu-compact-dlg/);   // 冷启动清扫选择器（v179 阈值行/v195 说明行同 swept）
  assert.match(source, /hcObserver\.observe\(document\.body/);
  assert.match(source, /syncCompactBtn\(\);\s*\/\/ v105/);   // heavy 对账点
  assert.match(source, /onSendCompressionCommand/);
  assert.match(source, /__zcodeLexicalInputE2E/);
  assert.match(source, /data-e2e-lexical-bridge/);
});

test('v316 视格契约：胶囊按钮 flex 居中/40px/无边框/中性叠加底 + SVG 图标 + 主题分组', () => {
  /* 布局与几何：全宽 40px 胶囊、flex 图文居中、13px/600、nowrap */
  assert.match(source, /\.zu-compact-btn\{display:flex;align-items:center;justify-content:center;gap:8px;/);
  assert.match(source, /\.zu-compact-btn\{[^}]*width:100%;min-width:0;height:40px/);
  assert.match(source, /\.zu-compact-btn\{[^}]*border:0;border-radius:9999px/);
  assert.match(source, /\.zu-compact-btn\{[^}]*font-size:calc\(var\(--ui-font-size,14px\) - 1px\);font-weight:600/);
  assert.match(source, /\.zu-compact-btn\{[^}]*white-space:nowrap/);
  /* 中性叠加底：暗色=白叠加三态，浅色=黑叠加三态（html.dark 分组），无渐变/阴影/边框 */
  assert.match(source, /\.zu-compact-btn\{[^}]*background:rgba\(255,255,255,\.065\)/);
  assert.match(source, /\.zu-compact-btn:hover\{background:rgba\(255,255,255,\.10\)\}/);
  assert.match(source, /\.zu-compact-btn:active\{background:rgba\(255,255,255,\.14\)\}/);
  assert.match(source, /html:not\(\.dark\) \.zu-compact-btn\{background:rgba\(0,0,0,\.05\)\}/);
  assert.match(source, /html:not\(\.dark\) \.zu-compact-btn:hover\{background:rgba\(0,0,0,\.08\)\}/);
  assert.match(source, /html:not\(\.dark\) \.zu-compact-btn:active\{background:rgba\(0,0,0,\.12\)\}/);
  /* 键盘焦点环 / 禁用态 / 图标尺寸 */
  assert.match(source, /\.zu-compact-btn:focus-visible\{outline:2px solid var\(--color-focus-ring,#78aaff\);outline-offset:2px\}/);
  assert.match(source, /\.zu-compact-btn:disabled\{opacity:\.5;cursor:not-allowed\}/);
  assert.match(source, /\.zu-compact-btn svg\{width:18px;height:18px;flex:0 0 18px\}/);
  /* 收缩双箭头 SVG（向中心压缩语义）经 innerHTML 常量串注入，currentColor 随主题 */
  assert.match(source, /b\.innerHTML = '<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1\.8"/);
  assert.match(source, /<path d="M5 11h14"\/><path d="M5 13h14"\/><path d="M12 2v6"\/><path d="m9 5 3 3 3-3"\/>/);
  assert.match(source, /<path d="M12 22v-6"\/><path d="m9 19 3-3 3 3"\/><\/svg>/);
  assert.match(source, /b\.appendChild\(document\.createTextNode\(L\("压缩上下文", "Compact context"\)\)\)/);
  /* reduced-motion 组关按钮过渡：组必须整体排在受控基础规则之后（@media 不增特异性，
   * 同特异性源序后者胜——前置会被按钮 transition 基础规则压成死代码，R1 审查实锤），
   * 用源序断言锁位置，字符串存在性测不出级联失效。 */
  assert.match(source, /\.it,\.btn,\.ttab,\.panel label,\.zu-compact-btn\{transition:none\}/);
  const rmGroupAt = source.indexOf('@media (prefers-reduced-motion:reduce){.exc,.dot');
  const btnTransitionAt = source.indexOf('.zu-compact-btn{display:flex');
  assert.ok(rmGroupAt > -1, 'reduced-motion 组存在');
  assert.ok(btnTransitionAt > -1, '按钮基础规则存在');
  assert.ok(rmGroupAt > btnTransitionAt, 'reduced-motion 组必须后置（否则死代码）');
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
  const hint = ui.body.children.find(e => e.classList.contains('zu-ac-hint'));
  assert.ok(hint, 'v195 新手说明行挂载');
  assert.equal(ui.body.children.indexOf(info), ui.body.children.indexOf(hint) - 1, '说明行紧随阈值行');
  assert.equal(ui.body.children.indexOf(hint), ui.body.children.indexOf(btn) - 2, '说明行钉在按钮行（extBtn+压缩按钮）上方');
  assert.match(hint.textContent, /按窗口总量计算/);
  const infoText = info.children.find(e => e.classList && e.classList.contains('zu-ac-text'));
  assert.ok(infoText, '文本 span 存在');
  assert.match(infoText.textContent, /自动压缩 ~70%/);      // v194 总窗口口径：200,000×70% = 140,000 → 70%（设置值=显示值）
  assert.match(infoText.textContent, /14万 token/);   // token 数走 fmt()（默认中文万单位，至多两位小数）
  const link = info.children.find(e => e.classList && e.classList.contains('zu-ac-link'));
  assert.ok(link, '下划线「调整」链接存在');
  assert.equal(link.textContent, '调整');
  h.tick();
  assert.equal(ui.body.children.find(e => e.classList.contains('zu-ac-info')), info, '幂等：同一颗行不被重建');
  assert.equal(ui.body.children.find(e => e.classList.contains('zu-ac-hint')), hint, '说明行不被重建');
  assert.equal(info.children.find(e => e.classList && e.classList.contains('zu-ac-link')), link, '链接不被重建（文本单独更新）');
  h.window.__zusagePluginUpdate({ enginePatch: { enabled: true, state: 'applied', build: '3.17.1', config: { enabled: false } } });
  h.tick();
  assert.equal(ui.body.children.find(e => e.classList.contains('zu-ac-info')), info, '原地更新不重建');
  assert.match(info.children.find(e => e.classList && e.classList.contains('zu-ac-text')).textContent, /已禁用/);
  assert.equal(info.children.find(e => e.classList && e.classList.contains('zu-ac-link')), link, '原地更新后链接仍在');
  h.window.__zusagePluginUpdate({ enginePatch: { enabled: true, state: 'unsupported_build', build: null } });
  h.tick();
  assert.ok(!ui.body.children.find(e => e.classList.contains('zu-ac-info')), '补丁未生效即摘除');
  assert.ok(!ui.body.children.find(e => e.classList.contains('zu-ac-hint')), '说明行随阈值行一并摘除');
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
  assert.ok(!ui.body.children.find(e => e.classList.contains('zu-ac-hint')));
});

/* ---------- v200 压缩按钮开关（issue #174）：zusage3.ctxCpt 缺省开仅显式 "0" 关 ---------- */

test('v200 开关关闭（zusage3.ctxCpt="0"）：弹层不注入压缩按钮，阈值行顶到「剩余额度」段上方', () => {
  const h = harness({ ls: { 'zusage3.ctxCpt': '0' } });
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.window.__zusagePluginState.enginePatch = { enabled: true, state: 'applied', build: '3.17.1', config: { enabled: true, thresholdPercent: 70 } };
  h.inject(); h.boot(); h.tick();
  assert.equal(h.compactBtnOf(ui.body), undefined, '按钮不注入');
  const info = ui.body.children.find(e => e.classList.contains('zu-ac-info'));
  const hint = ui.body.children.find(e => e.classList.contains('zu-ac-hint'));
  assert.ok(info && hint, '阈值行/说明行不受本开关影响（v179 独立生命周期）');
  assert.equal(ui.body.children.indexOf(info), ui.body.children.indexOf(ui.borderT) - 3, '阈值行顶到「上下文明细」按钮上方');
  assert.equal(ui.body.children.indexOf(hint), ui.body.children.indexOf(ui.borderT) - 2);
  h.tick();
  assert.equal(h.compactBtnOf(ui.body), undefined, '幂等：继续对账按钮不再出现');
});

test('v200 运行期切换：按钮挂载中关掉即摘除补位，重开即原位重挂', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.window.__zusagePluginState.enginePatch = { enabled: true, state: 'applied', build: '3.17.1', config: { enabled: true, thresholdPercent: 70 } };
  h.inject(); h.boot(); h.tick();
  const btn = h.compactBtnOf(ui.body);
  assert.ok(btn, '前置：开关缺省开，按钮已挂载');
  const info = ui.body.children.find(e => e.classList.contains('zu-ac-info'));
  assert.equal(ui.body.children.indexOf(info), ui.body.children.indexOf(btn) - 3, '前置：阈值行+说明行钉在按钮行上方');
  h.window.compactTest.state().ctxCpt = 0;
  h.tick();
  assert.equal(h.compactBtnOf(ui.body), undefined, '关闭：按钮摘除');
  assert.equal(ui.body.children.indexOf(info), ui.body.children.indexOf(ui.borderT) - 3, '阈值行顶到上下文明细按钮上方');
  const hint = ui.body.children.find(e => e.classList.contains('zu-ac-hint'));
  assert.equal(ui.body.children.indexOf(hint), ui.body.children.indexOf(ui.borderT) - 2, '说明行随阈值行补位');
  h.window.compactTest.state().ctxCpt = 1;
  h.tick();
  const btn2 = h.compactBtnOf(ui.body);
  assert.ok(btn2, '重开：按钮重挂');
  assert.equal(ui.body.children.indexOf(btn2), ui.body.children.indexOf(ui.borderT) - 1, '重挂位置：「剩余额度」段上方');
  const info2 = ui.body.children.find(e => e.classList.contains('zu-ac-info'));
  assert.equal(ui.body.children.indexOf(info2), ui.body.children.indexOf(btn2) - 3, '阈值行回到按钮行上方');
});

test('v200 开关关闭且无阈值行：弹层仅摘按钮，无残留', () => {
  const h = harness({ ls: { 'zusage3.ctxCpt': '0' } });
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.inject(); h.boot(); h.tick();
  assert.equal(h.compactBtnOf(ui.body), undefined);
  const zuLeft = ui.body.children.filter(e => e.classList && String(e.className).indexOf('zu-') === 0).map(e => String(e.className));
  assert.deepEqual(zuLeft, ['zu-ext-ctx-btn'], '除扩展入口按钮外，无任何其它插件节点残留');
});

test('v200 ⚙ 开关全链路（真实面板 change）：关掉即摘按钮，开着确认框时兜底收起', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  const ui = h.buildHoverCard({ withBorderT: true });
  h.inject(); h.boot(); h.tick();
  assert.ok(h.compactBtnOf(ui.body), '前置：按钮已挂载');
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  const box = panel.querySelector('.zu-cpt-btn');
  box.classList.add('zu-cpt-btn');   // 惰性桩 classList 为空：补类名让 change 分支可命中
  box.checked = false;
  panel.dispatch('change', { target: box });
  assert.equal(h.window.compactTest.state().ctxCpt, 0, 'state 落账');
  assert.equal(h.compactBtnOf(ui.body), undefined, 'change 分支直调 syncCompactBtn：按钮即时摘除');
  h.window.compactTest.state().ctxCpt = 1;
  h.tick();
  h.compactBtnOf(ui.body).dispatch('click');
  assert.ok(h.dlgEl(), '前置：确认框已打开');
  box.checked = false;
  panel.dispatch('change', { target: box });
  assert.equal(h.dlgEl(), undefined, '兜底收起确认框（正常被遮罩挡住进不到设置）');
  assert.equal(h.window.compactTest.state().ctxCpt, 0);
});

/* ---------- v487 上下文容量弹层分项构成增强（Token 数 + 悬停说明 + 独立开关） ---------- */

test('v487 分项构成增强：计算估算 Token 数（24.3万 · 74.7%），支持万/亿与 K/M/B 切换，重复对账幂等', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 325,000 / 总量 1,000,000');
  const ui = h.buildHoverCard({
    withBorderT: true,
    breakdown: [
      { label: '消息', pct: '74.7%' },
      { label: '其他', pct: '17.5%' },
      { label: '系统工具', pct: '5.7%' },
      { label: '技能', pct: '1.3%' },
      { label: '系统提示词', pct: '0.9%' },
    ],
  });
  h.inject(); h.boot(); h.tick();
  const tokOf = r => r.row.children.find(c => c.classList && c.classList.contains('zu-ctx-bkd-tok'));
  // 325000 * 74.7% = 242775 -> fmt(242775) = 24.28万
  assert.ok(tokOf(ui.bkdRows[0]), '首行已注入 token 节点');
  assert.equal(tokOf(ui.bkdRows[0]).textContent, '24.28万 · ');
  assert.equal(ui.bkdRows[0].row.children.indexOf(tokOf(ui.bkdRows[0])), ui.bkdRows[0].row.children.indexOf(ui.bkdRows[0].pct) - 1, '插在百分比节点紧前面');
  // 325000 * 0.9% = 2925 (<1万保持原值)
  assert.equal(tokOf(ui.bkdRows[4]).textContent, '2925 · ');
  const firstTokNode = tokOf(ui.bkdRows[0]);
  h.tick();
  assert.equal(tokOf(ui.bkdRows[0]), firstTokNode, '幂等：同一节点原地复用不重复插入');
  assert.equal(ui.bkdRows[0].row.children.filter(c => c.classList && c.classList.contains('zu-ctx-bkd-tok')).length, 1);

  // 切换强制 K/M/B 时同拍刷新为 K/M/B 格式
  h.window.compactTest.state().forceKmb = 1;
  h.tick();
  assert.equal(tokOf(ui.bkdRows[0]).textContent, '242.8K · ');
  assert.equal(tokOf(ui.bkdRows[4]).textContent, '2.9K · ');
});

test('v487 悬停大白话说明：7 类中英标签均能识别，mouseover 弹出说明气泡、mouseout 与弹层卸载即收起', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 200,000');
  const ui = h.buildHoverCard({
    withBorderT: true,
    breakdown: [
      { label: '消息', pct: '50.0%' },
      { label: '其他', pct: '20.0%' },
      { label: '系统工具', pct: '10.0%' },
      { label: 'MCP 工具', pct: '8.0%' },
      { label: '技能', pct: '5.0%' },
      { label: '系统提示词', pct: '4.0%' },
      { label: '工具提示词', pct: '3.0%' },
    ],
  });
  h.inject(); h.boot(); h.tick();
  const expectedKeys = ['messages', 'meta_user_context', 'system_tool_schemas', 'mcp_tool_schemas', 'skills', 'system_prompt', 'tool_prompt'];
  ui.bkdRows.forEach((r, idx) => {
    assert.equal(r.row.getAttribute('data-zusage-bkd'), expectedKeys[idx], `第 ${idx} 行 key 识别正确`);
  });

  const tip = h.bkdTipEl();
  assert.ok(tip, '文档级单例气泡已挂载');
  assert.equal(tip.style.display, 'none', '初始隐藏');

  // 悬停「其他」行
  ui.body.dispatch('mouseover', { target: ui.bkdRows[1].lbl });
  assert.equal(tip.style.display, 'block', '悬停后显示');
  assert.match(tip.innerHTML, /AGENTS\.md/, '包含其他项大白话说明');
  assert.match(tip.innerHTML, /≈ 2万 token \(20,000\)/, '显示估算用量与精确千分位');
  assert.match(tip.innerHTML, /占已用 20\.0% · 占总窗口 10\.0%/, '显示双口径占比');
  assert.match(tip.innerHTML, /包含内容/, '显示结构化清单标题');

  // 移到「MCP 工具」行
  ui.body.dispatch('mouseout', { target: ui.bkdRows[1].lbl, relatedTarget: ui.bkdRows[3].row });
  assert.equal(tip.style.display, 'block', '跨行切换保持显示');
  assert.match(tip.innerHTML, /关闭当前任务不需要的 MCP/, '内容切换为 MCP 工具说明');

  // 移出分项区（350ms 悬停保活桥后隐藏）
  ui.body.dispatch('mouseout', { target: ui.bkdRows[3].row, relatedTarget: ui.body });
  assert.equal(tip.style.display, 'block', '保活桥窗口内暂不收起');
  h.flushTimeouts(350);
  assert.equal(tip.style.display, 'none', '到期后隐藏');
  h.tick();
  assert.equal(tip.style.display, 'none', '隐藏后的下一拍对账不把气泡重新拉起');

  // 再次悬停后模拟 Radix 卸载弹层，500ms 健康检查兜底收起
  ui.body.dispatch('mouseover', { target: ui.bkdRows[0].row });
  assert.equal(tip.style.display, 'block');
  ui.bkdRows[0].row.isConnected = false;
  h.tick();
  assert.equal(tip.style.display, 'none', '宿主卸载分项行后兜底收起');
});

test('v487 英文界面与独立开关（zusage3.ctxBkd）：关闭即摘除 Token 节点与属性并收起气泡，重开即恢复', () => {
  const h = harness({ lang: 'en' });
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', 'Context usage 200,000 of 1,000,000');
  const ui = h.buildHoverCard({
    withBorderT: true,
    breakdown: [
      { label: 'Messages', pct: '60.0%' },
      { label: 'Meta context', pct: '40.0%' },
    ],
  });
  h.inject(); h.boot(); h.tick();
  const tokOf = r => r.row.children.find(c => c.classList && c.classList.contains('zu-ctx-bkd-tok'));
  assert.equal(tokOf(ui.bkdRows[0]).textContent, '120.0K · ');
  ui.body.dispatch('mouseover', { target: ui.bkdRows[0].row });
  const tip = h.bkdTipEl();
  assert.equal(tip.style.display, 'block');
  assert.match(tip.innerHTML, /Chat turns/);

  // 通过 ⚙ 通用面板关闭 .zu-ctx-bkd 开关
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  const box = panel.querySelector('.zu-ctx-bkd');
  box.classList.add('zu-ctx-bkd');
  box.checked = false;
  panel.dispatch('change', { target: box });

  assert.equal(h.window.compactTest.state().ctxBkd, 0, 'state.ctxBkd 落账 0');
  assert.equal(tokOf(ui.bkdRows[0]), undefined, 'Token 节点即时摘除');
  assert.equal(ui.bkdRows[0].row.getAttribute('data-zusage-bkd'), null, 'data-zusage-bkd 属性已清理');
  assert.equal(tip.style.display, 'none', '在显说明气泡同步收起');

  // 重新开启
  box.checked = true;
  panel.dispatch('change', { target: box });
  assert.equal(h.window.compactTest.state().ctxBkd, 1);
  assert.equal(tokOf(ui.bkdRows[0]).textContent, '120.0K · ', '重开后原位恢复');
  assert.equal(ui.bkdRows[0].row.getAttribute('data-zusage-bkd'), 'messages');
});

test('v487 结构化明细增强：从 React Fiber 读取 taskUsage 原始字符数与缓存命中率明细', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 35,721 / 总量 1,000,000');
  comp.btn['__reactFiber$fixture'] = {
    memoizedProps: {
      taskUsage: {
        used: 35721,
        size: 1000000,
        cache: {
          inputTokens: 35500,
          cacheReadTokens: 35264,
          cacheWriteTokens: 0,
          latestHitRate: 0.993,
          hitRateRequestCount: 6,
          totalInputTokens: 203081,
          totalCacheReadTokens: 164672,
          hitRate: 0.811,
        },
        breakdown: [
          { source: 'meta_user_context', chars: 51809 },
          { source: 'messages', chars: 17921 },
        ],
      },
    },
    return: null,
  };
  const ui = h.buildHoverCard({
    withBorderT: true,
    breakdown: [
      { label: '其他', pct: '74.3%' },
      { label: '消息', pct: '25.7%' },
    ],
  });
  h.inject(); h.boot(); h.tick();
  const tip = h.bkdTipEl();

  // 悬停「其他」行：应含原始文本字符数
  ui.body.dispatch('mouseover', { target: ui.bkdRows[0].row });
  assert.equal(tip.style.display, 'block');
  assert.match(tip.innerHTML, /5\.18万 字符 \/ 共 6\.97万/, '显示原始文本与总文本字符数');

  // 悬停「平均缓存命中率」行：应含最近一次、累计、主轮次数
  assert.equal(ui.cacheRow.getAttribute('data-zusage-bkd-cache'), '1');
  ui.body.dispatch('mouseover', { target: ui.cacheRow });
  assert.equal(tip.style.display, 'block');
  assert.match(tip.innerHTML, /99\.3% \(3\.53万 \/ 3\.55万\)/, '显示最近一次请求命中率与 token 比例');
  assert.match(tip.innerHTML, /81\.1% \(16\.47万 \/ 20\.31万\)/, '显示本会话累计命中率与 token 比例');
  assert.match(tip.innerHTML, /6 次/, '显示统计主轮数');

  // 开关关闭时摘除缓存行标记与气泡
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  const box = panel.querySelector('.zu-ctx-bkd');
  box.classList.add('zu-ctx-bkd');
  box.checked = false;
  panel.dispatch('change', { target: box });
  assert.equal(ui.cacheRow.getAttribute('data-zusage-bkd-cache'), null);
  assert.equal(tip.style.display, 'none');
});

test('v487 技能列表、其他路径、系统提示词名称与路径展示；气泡纯说明、指针穿透', () => {
  const h = harness();
  const opened = [];
  h.window.zcode = { openInFileManager: p => opened.push(p) };
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 1,000,000');
  comp.btn['__reactFiber$fixture'] = {
    memoizedProps: {
      taskUsage: { used: 100000, size: 1000000 },
      workspacePath: '/Users/alice/Projects/demo-app',
      snapshot: {
        rows: {
          window: [
            {
              toolName: 'Skill',
              input: { skill: 'zcode-review-fix-merge' },
              output: { text: 'ok\nBase directory for this skill: /Users/alice/Projects/demo-app/.zcode/skills/zcode-review-fix-merge\n' },
            },
          ],
        },
      },
    },
    return: null,
  };
  const ui = h.buildHoverCard({
    withBorderT: true,
    breakdown: [
      { label: '技能', pct: '1.2%' },
      { label: '其他', pct: '17.5%' },
      { label: '系统提示词', pct: '0.9%' },
    ],
  });
  h.inject(); h.boot(); h.tick();
  const tip = h.bkdTipEl();

  // 1. 技能：列出已用技能和目录位置
  ui.body.dispatch('mouseover', { target: ui.bkdRows[0].row });
  assert.match(tip.innerHTML, /近期已用技能.*\(1\)/);
  assert.match(tip.innerHTML, /zcode-review-fix-merge/);
  assert.match(tip.innerHTML, /\/Users\/alice\/\.zcode\/skills/);
  assert.match(tip.innerHTML, /\/Users\/alice\/Projects\/demo-app\/\.zcode\/skills/);

  // 2. 其他：指令规则、记忆索引、动态系统提醒
  ui.body.dispatch('mouseover', { target: ui.bkdRows[1].row });
  assert.match(tip.innerHTML, /全局 AGENTS\.md/);
  assert.match(tip.innerHTML, /项目 AGENTS\.md/);
  assert.match(tip.innerHTML, /\/\.zcode\/cli\/memories\/projects\/&lt;工作区标识&gt;\/memory\/MEMORY\.md/, '记忆索引写宿主真实布局');
  assert.doesNotMatch(tip.innerHTML, /\.zcode\/projects/, '不再出现不存在的 ~/.zcode/projects');
  assert.match(tip.innerHTML, /ToolSearch 公告/);

  // 3. 系统提示词：核心段名称 + 内置引擎路径
  ui.body.dispatch('mouseover', { target: ui.bkdRows[2].row });
  assert.match(tip.innerHTML, /core（核心身份与能力）/);
  assert.match(tip.innerHTML, /guidelines（编码与执行规范）/);
  assert.match(tip.innerHTML, /\/Applications\/ZCode\.app\/Contents\/Resources\/glm\/zcode\.cjs/);

  // 4. 点击路径打开文件夹：pointerdown 命中 .cb-path 调用 openInFileManager，悬停气泡期间保持显示
  assert.notEqual(tip.style.pointerEvents, 'none', '气泡可交互');
  const pathNode = new Element('span');
  pathNode.className = 'cb-path';
  pathNode.setAttribute('data-cb-path', '/Applications/ZCode.app/Contents/Resources/glm');
  pathNode.closest = sel => sel === '.cb-path' ? pathNode : null;
  tip.dispatch('pointerdown', { target: pathNode });
  assert.deepEqual(opened, ['/Applications/ZCode.app/Contents/Resources/glm']);

  // 5. 鼠标从行移入气泡：取消隐藏定时器；即使宿主卸载或动画抖动仍保持显示，离开气泡 350ms 后才隐藏
  ui.body.dispatch('mouseout', { target: ui.bkdRows[2].row, relatedTarget: tip });
  tip.dispatch('mouseenter', {});
  h.flushTimeouts(350);
  assert.equal(tip.style.display, 'block', '悬停气泡内取消隐藏定时器');
  ui.bkdRows[2].row.isConnected = false;
  h.tick();
  assert.equal(tip.style.display, 'block', '悬停气泡期间即使宿主卸载仍保持显示');
  tip.dispatch('mouseleave', {});
  h.flushTimeouts(350);
  assert.equal(tip.style.display, 'none', '移出气泡 350ms 后收起');
});

/* ---------- v487 审查补测：折算边界、开关、定位、路径与生命周期 ---------- */

test('v487 折算四舍五入、小数逗号百分比与降级：101×50.0%→51，「33,3 %」按 33.3 解析，已用量或百分比取不到不出数', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 101 / 总量 1,000');
  const ui = h.buildHoverCard({
    withBorderT: true,
    breakdown: [
      { label: '消息', pct: '50.0%' },
      { label: '技能', pct: '—' },   // 解析失败的行放在中段：后面的行不能被连累
      { label: '其他', pct: '33,3 %' },
    ],
  });
  h.inject(); h.boot(); h.tick();
  const tokOf = r => r.row.children.find(c => c.classList && c.classList.contains('zu-ctx-bkd-tok'));
  assert.equal(tokOf(ui.bkdRows[0]).textContent, '51 · ', '50.5 四舍五入进位（截尾会得 50）');
  assert.equal(tokOf(ui.bkdRows[1]), undefined, '百分比解析失败不出数');
  assert.equal(tokOf(ui.bkdRows[2]).textContent, '34 · ', '小数逗号按 33.3 解析（不把逗号当小数点会得 33）');
  ui.body.dispatch('mouseover', { target: ui.bkdRows[2].row });
  assert.match(h.bkdTipEl().innerHTML, /占已用 33,3 %/, '气泡里的占比串照抄宿主原文');
  comp.btn.setAttribute('aria-label', '上下文已用 0 / 总量 1,000');
  h.tick();
  assert.equal(tokOf(ui.bkdRows[0]), undefined, '已用量取不到时摘除已插入节点');
});

test('v487 开关：启动时 zusage3.ctxBkd="0" 不注入也不弹气泡；运行中开关落 0 后下一拍对账即摘除并收起', () => {
  const off = harness({ ls: { 'zusage3.ctxBkd': '0' } });
  const comp0 = off.buildComposer('workspace-main', 'sid_main');
  comp0.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 1,000,000');
  const ui0 = off.buildHoverCard({ withBorderT: true, breakdown: [{ label: '消息', pct: '60.0%' }] });
  off.inject(); off.boot(); off.tick();
  const hasTok = r => r.row.children.some(c => c.classList && c.classList.contains('zu-ctx-bkd-tok'));
  assert.equal(off.window.compactTest.state().ctxBkd, 0, '启动读到显式 "0"');
  assert.equal(hasTok(ui0.bkdRows[0]), false, '启动即不注入 Token 节点');
  assert.equal(ui0.bkdRows[0].row.getAttribute('data-zusage-bkd'), null, '不打行标记');
  ui0.body.dispatch('mouseover', { target: ui0.bkdRows[0].row });
  assert.equal(off.bkdTipEl().style.display, 'none', '不弹气泡');

  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 1,000,000');
  const ui = h.buildHoverCard({ withBorderT: true, breakdown: [{ label: '消息', pct: '60.0%' }] });
  h.inject(); h.boot(); h.tick();
  const tip = h.bkdTipEl();
  ui.body.dispatch('mouseover', { target: ui.bkdRows[0].row });
  assert.equal(tip.style.display, 'block');
  h.window.compactTest.state().ctxBkd = 0;   // 不经设置面板直接落 0：由对账分支兜底
  h.tick();
  assert.equal(tip.style.display, 'none', '对账发现开关关即收起在显气泡');
  assert.equal(hasTok(ui.bkdRows[0]), false, '对账发现开关关即摘除');
});

test('v488 气泡侧边定位、坐标锁定与主题：紧贴行右侧（放不下放左侧）、同 row 锁定防动画抖动、浅色主题挂 zu-light', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 200,000');
  const ui = h.buildHoverCard({ withBorderT: true, breakdown: [{ label: '消息', pct: '50.0%' }] });
  h.inject(); h.boot(); h.tick();
  const tip = h.bkdTipEl();
  tip.offsetWidth = 200; tip.offsetHeight = 100;
  const row = ui.bkdRows[0].row;
  h.document.documentElement.classList.add('dark');
  row._rect = { top: 600, bottom: 620, left: 100, right: 400, width: 300, height: 20 };
  ui.body.dispatch('mouseover', { target: row });
  assert.equal(tip.style.display, 'block');
  assert.equal(tip.style.left, '396px', '优先贴右侧（4px 重叠）');
  assert.equal(tip.style.top, '596px', '对齐行顶 -4px');
  assert.ok(!tip.classList.contains('zu-light'), '深色主题不挂 zu-light');

  // 同一行对账拍：即使 row._rect 抖动也锁定坐标不重算
  row._rect = { top: 615, bottom: 635, left: 105, right: 405, width: 300, height: 20 };
  h.tick();
  assert.equal(tip.style.left, '396px', '同一行锁定 left');
  assert.equal(tip.style.top, '596px', '同一行锁定 top');

  // 移出后切到浅色主题并重悬停（右侧超出视口时翻到左侧）
  ui.body.dispatch('mouseout', { target: row, relatedTarget: ui.body });
  h.flushTimeouts(350);
  h.document.documentElement.classList.remove('dark');
  row._rect = { top: 20, bottom: 40, left: 950, right: 990, width: 40, height: 20 };
  ui.body.dispatch('mouseover', { target: row });
  assert.equal(tip.style.left, '754px', '右侧放不下翻到左侧（950 - 200 + 4）');
  assert.ok(tip.classList.contains('zu-light'), '浅色主题挂 zu-light');
});

test('v487 Windows 路径、技能去重与目录可信限制：同技能只列一次并补全目录，home 与工作区之外的目录不展示', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 1,000,000');
  comp.btn['__reactFiber$fixture'] = {
    memoizedProps: {
      taskUsage: { used: 100000, size: 1000000 },
      workspacePath: 'C:\\Users\\bob\\proj',
      snapshot: {
        rows: {
          window: [
            { kind: 'toolCall', toolName: 'Skill', inputText: '{"skill":"alpha"}' },   // 无 output：先登记，目录留空
            { kind: 'toolCall', toolName: 'Skill', input: { skill: 'alpha' }, output: { text: 'Base directory for this skill: C:\\Users\\bob\\proj\\.zcode\\skills\\alpha\n' } },
            { kind: 'toolCall', toolName: 'Skill', input: { skill: 'stray' }, output: { text: 'Base directory for this skill: D:\\elsewhere\\stray\n' } },
            { kind: 'toolCall', toolName: 'Skill', input: { skill: 'sneaky' }, output: { text: 'Base directory for this skill: C:\\Users\\bob\\proj\\.zcode\\skills\\..\\..\\..\\private\\sneaky\n' } },
            { kind: 'toolCall', toolName: 'Skill', input: { skill: 'sneaky2' }, output: { text: 'Base directory for this skill: C:\\Users\\bob\\proj\\.zcode\\skills/../../private\n' } },   // 正斜杠形式的穿越
            { kind: 'toolCall', toolName: 'Skill', inputText: '{"skill":"beta"}' },   // 只带 inputText 的行
          ],
        },
      },
    },
    return: null,
  };
  const ui = h.buildHoverCard({ withBorderT: true, breakdown: [{ label: '技能', pct: '1.2%' }, { label: '其他', pct: '17.5%' }] });
  h.inject(); h.boot(); h.tick();
  const tip = h.bkdTipEl();
  const linkTargets = () => [...tip.innerHTML.matchAll(/data-cb-path="([^"]*)"/g)].map(m => m[1]);
  ui.body.dispatch('mouseover', { target: ui.bkdRows[0].row });
  assert.match(tip.innerHTML, /近期已用技能.*\(5\)/, '同名技能去重后 5 个（alpha、stray、sneaky、sneaky2、beta）');
  assert.deepEqual(linkTargets(), ['C:\\Users\\bob\\proj\\.zcode\\skills\\alpha', 'C:\\Users\\bob\\.zcode\\skills', 'C:\\Users\\bob\\proj\\.zcode\\skills'],
    '已用技能只在 home/工作区之下才展示目录；目录按反斜杠拼接');
  assert.match(tip.innerHTML, /<span class="cb-tag">stray<\/span>/, 'home 与工作区之外的技能目录只列名称');
  assert.match(tip.innerHTML, /<span class="cb-tag">sneaky<\/span>/, '字面落在工作区之下、实际用「..」穿出去的目录同样只列名称');
  assert.match(tip.innerHTML, /<span class="cb-tag">sneaky2<\/span>/, '正斜杠形式的「..」穿越同样只列名称');
  assert.match(tip.innerHTML, /<span class="cb-tag">beta<\/span>/, '只带 inputText 的技能行也列出名称');
  ui.body.dispatch('mouseover', { target: ui.bkdRows[1].row });
  assert.ok(linkTargets().includes('C:\\Users\\bob\\.zcode\\cli\\memories\\projects'), '记忆索引路径指向真实布局');
  assert.doesNotMatch(tip.innerHTML, /\.zcode\/projects/);
});

test('v487 英文弹层：其余五类英文标签与「Average cache hit rate」行均识别；aria-label 缺失时已用量取 taskUsage.used', () => {
  const h = harness({ lang: 'en' });
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.removeAttribute('aria-label');
  comp.btn['__reactFiber$fixture'] = {
    memoizedProps: {
      taskUsage: { used: 200000, size: 1000000, cache: { latestHitRate: 0.9, inputTokens: 100, cacheReadTokens: 90, hitRate: 0.8, totalInputTokens: 1000, totalCacheReadTokens: 800, hitRateRequestCount: 4 } },
    },
    return: null,
  };
  const ui = h.buildHoverCard({
    withBorderT: true,
    breakdown: [
      { label: 'System tools', pct: '10.0%' }, { label: 'MCP tools', pct: '5.0%' }, { label: 'Skills', pct: '2.0%' },
      { label: 'System prompt', pct: '1.0%' }, { label: 'Tool prompt', pct: '0.5%' },
    ],
  });
  h.inject(); h.boot(); h.tick();
  const keys = ['system_tool_schemas', 'mcp_tool_schemas', 'skills', 'system_prompt', 'tool_prompt'];
  ui.bkdRows.forEach((r, i) => assert.equal(r.row.getAttribute('data-zusage-bkd'), keys[i], `英文第 ${i} 行 key`));
  const tokOf = r => r.row.children.find(c => c.classList && c.classList.contains('zu-ctx-bkd-tok'));
  assert.equal(tokOf(ui.bkdRows[0]).textContent, '20.0K · ', 'aria-label 缺失时用 taskUsage.used=200000 折算');
  assert.equal(ui.cacheRow.getAttribute('data-zusage-bkd-cache'), '1', '英文缓存命中率行打标记');
  ui.body.dispatch('mouseover', { target: ui.cacheRow });
  assert.match(h.bkdTipEl().innerHTML, /Latest request/);
});

test('v487 热重载：弹层没关时重新注入，新一代仍能弹出气泡（委托标记带代际）', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 1,000,000');
  const ui = h.buildHoverCard({ withBorderT: true, breakdown: [{ label: '消息', pct: '50.0%' }] });
  h.inject(); h.boot(); h.tick();
  ui.body.dispatch('mouseover', { target: ui.bkdRows[0].row });
  assert.equal(h.bkdTipEl().style.display, 'block', '第一代正常弹出');
  h.inject(); h.boot(); h.tick();   // 第二代注入（热重载）：宿主弹层没关，body 还是同一个
  const tips = h.body.children.filter(e => e.classList.contains('zusage-ctx-bkd-tip'));
  assert.equal(tips.length, 1, '旧代气泡被启动自清，只剩新一代');
  assert.equal(tips[0].style.display, 'none');
  ui.body.dispatch('mouseover', { target: ui.bkdRows[0].lbl });
  assert.equal(tips[0].style.display, 'block', '新一代的委托已挂到同一个 body');
});
/* 未单测的一处：08 分片两处 `syncCompactBtn()` 重算调用（单位/语言切换时同拍刷新）。它们在 `render()`
 * 尾部，只有收到过数据推送（`state.data`）才会进入；本夹具不推数据，覆盖不到。到不了它们时由 heavy()
 * 的 600ms 兜底拍刷新，只影响时延、不影响结果（上面「切换强制 K/M/B」用例锁的就是兜底拍路径）。 */

test('v487 开关持久化：⚙ 面板切换 .zu-ctx-bkd 后 localStorage 写入 zusage3.ctxBkd=0/1', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 1,000,000');
  h.inject(); h.boot(); h.tick();
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  const box = panel.querySelector('.zu-ctx-bkd');
  box.classList.add('zu-ctx-bkd');
  box.checked = false; panel.dispatch('change', { target: box });
  assert.equal(h.lsWrites['zusage3.ctxBkd'], '0', '关闭写入 "0"（下次启动读到即不注入）');
  box.checked = true; panel.dispatch('change', { target: box });
  assert.equal(h.lsWrites['zusage3.ctxBkd'], '1', '开启写入 "1"');
});

test('v487 整张弹层被宿主卸载后，500ms 健康检查兜底收起气泡（此时已无弹层可对账）', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 1,000,000');
  const ui = h.buildHoverCard({ withBorderT: true, breakdown: [{ label: '消息', pct: '50.0%' }] });
  h.inject(); h.boot(); h.tick();
  const tip = h.bkdTipEl();
  ui.body.dispatch('mouseover', { target: ui.bkdRows[0].row });
  assert.equal(tip.style.display, 'block');
  ui.hc.isConnected = false; ui.bkdRows[0].row.isConnected = false;   // Radix 卸载：卡片连同行一起离开文档
  h.tick();
  assert.equal(tip.style.display, 'none', '对账拍已看不到弹层，由健康检查收起');
});

test('v487 对账摘除：缓存明细消失后缓存行摘标记；行标签变成未知类别后摘标记且不再弹气泡，Token 数照常显示', () => {
  const h = harness();
  const comp = h.buildComposer('workspace-main', 'sid_main');
  comp.btn.setAttribute('aria-label', '上下文已用 100,000 / 总量 1,000,000');
  const props = { taskUsage: { used: 100000, size: 1000000, cache: { latestHitRate: 0.9, hitRate: 0.8 } } };
  comp.btn['__reactFiber$fixture'] = { memoizedProps: props, return: null };
  const ui = h.buildHoverCard({ withBorderT: true, breakdown: [{ label: '消息', pct: '60.0%' }, { label: '其他', pct: '40.0%' }] });
  h.inject(); h.boot(); h.tick();
  const tip = h.bkdTipEl();
  assert.equal(ui.cacheRow.getAttribute('data-zusage-bkd-cache'), '1');
  props.taskUsage = { used: 100000, size: 1000000 };   // 缓存明细没了
  ui.bkdRows[1].lbl.textContent = '新类别';             // 行标签变成未知类别
  h.tick();
  assert.equal(ui.cacheRow.getAttribute('data-zusage-bkd-cache'), null, '缓存明细消失后摘标记');
  assert.equal(ui.cacheRow.__zuBkdCache, null);
  assert.equal(ui.bkdRows[1].row.getAttribute('data-zusage-bkd'), null, '未知类别摘标记');
  assert.equal(ui.bkdRows[1].row.__zuBkdData, null);
  ui.body.dispatch('mouseover', { target: ui.bkdRows[1].row });
  assert.equal(tip.style.display, 'none', '未知类别不弹气泡');
  assert.ok(ui.bkdRows[1].row.children.some(c => c.classList && c.classList.contains('zu-ctx-bkd-tok')), 'Token 数不依赖类别，照常显示');
});

test('context breakdown: the built-in engine path is a native backslash path on the Windows renderer address (v495)', () => {
  const { readOverlayPart } = require('./helpers/overlay-extract.cjs');
  const fn = readOverlayPart('11-instance-toolbar-chips.js').match(/function bkdAppResourcesDir\(\) \{[\s\S]*?\n    \}/);
  assert.ok(fn, 'bkdAppResourcesDir 在 11 分片里');
  const run = href => new Function('location', fn[0] + '\nreturn bkdAppResourcesDir();')({ href });
  assert.equal(run('file:///D:/Program%20Files/ZCode/resources/app.asar/out/renderer/index.html'),
    'D:\\Program Files\\ZCode\\resources\\glm', 'file:///D:/… 归一成反斜杠，与同气泡里的其它路径一致');
  assert.equal(run('file:///D:/ZCode/resources/app.asar/out/renderer/assets/index.html'), 'D:\\ZCode\\resources\\glm', 'asar 之后的路径段截掉');
  assert.equal(run('file:///Applications/ZCode.app/Contents/Resources/app.asar/out/renderer/index.html'),
    '/Applications/ZCode.app/Contents/Resources/glm', 'macOS 路径不变');
  assert.equal(run('https://zcode.z.ai/remote/x'), '', '非 asar 页面返回空');
});
