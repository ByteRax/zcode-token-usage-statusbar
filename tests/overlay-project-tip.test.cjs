const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v214 项目累计统计卡（夹具与 overlay-cost-tip 同源：渲染路径一致性已由其项目格用例验证）。
 * 数据链断言：快照 cost_usd（USD 原值）× fx.rate → ¥；无 fx 诚实降级 $；开关关/旧快照不显假 0；
 * .tip-src 点击走 window.zcode.openExternal 桥。价表计算本身在 Python 侧，由 test_token_pricing 覆盖。 */
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
  get firstChild() { return this.children[0] || null; }
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
  get offsetWidth() { return 200; }
  get offsetHeight() { return 60; }
  getBoundingClientRect() { return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 }; }
}

function harness({ costLS = null, kmbLS = null, lang = 'zh' } = {}) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  window.__zusagePluginState = {};
  const store = new Map();
  if (costLS !== null) store.set('zusage3.cost', costLS);
  if (kmbLS !== null) store.set('zusage3.forceKmb', kmbLS);
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    /* rAF 走 0ms 定时器（boot() 可冲）：实例 spawn/heavy 对账挂 rAF，条不挂载 tooltip 就不会产生 */
    requestAnimationFrame: fn => { timers.set(++id, { fn, ms: 0, interval: false }); return id; },
    cancelAnimationFrame: n => { timers.delete(n); frames.delete(n); },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; this.connected = true; }
      disconnect() { this.connected = false; }
    },
  });
  /* 三个测试接缝：tips（四格 tooltip 内容）、tpsChipTipHTML（紧凑摘要）、instances/state */
  const executable = source
    .replace('for (var i = 0; i < els.length; i++) els[i].__tip = h.tips[i] || null;',
             'window.__zuTips = h.tips;\n      for (var i = 0; i < els.length; i++) els[i].__tip = h.tips[i] || null;')
    .replace('function wireTpsChip(chip) {', 'window.__zuTpsTip = tpsChipTipHTML;\n    function wireTpsChip(chip) {')
    .replace('function drawTip(el, keepTop) {', 'window.__zuDrawTip = drawTip;\n    function drawTip(el, keepTop) {')
    .replace(/\}\)\(\);\s*$/, 'window.costTest = { state: function() { return state; } };})();');
  function inject() { window.__zusageOverlay = false; if (!globalThis.__exeDumped) { globalThis.__exeDumped = true; fs.writeFileSync('/tmp/exe-full.js', executable); } vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
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
  function payload({ fx = { rate: 7.1, at: 1, source: 'test' }, withCost = true, todayCost = 2 } = {}) {
    const NOW = Date.now();   // pickCurrent 按 30min 活跃阈值选会话，须用新鲜时间戳
    const row = { sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: NOW - 1000, ctx_exc: 0,
      input: 10000, output: 2000, reasoning: 300, cache_read: 8000, cache_write: 100, total: 12000,
      turns: 2, requests: 4, tool_calls: 1, retries: 0, started: NOW - 60000, avg_tps: 0,
      last: { provider_id: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-FlashX',
        rates: { input: 0.29879, output: 1.04577, cache_read: 0.08516, cache_write: 0, key: 'glm-5.3-flashx' } },
      last_turn: { requests: 2, retries: 0, tool_calls: 0, tool_errors: 0, input: 5000, output: 800,
        reasoning: 100, cache_read: 4200, cache_write: 60, total: 5800, duration_ms: 4000, ttft_ms: 300,
        started: NOW - 50000, ended: NOW - 46000, tps: 100, rated_output: 800, unrated_output: 0, gen_ms: 3000,
        models: [{ model: 'GLM-5.3-FlashX', requests: 2, total: 5800, cost_usd: 0.5 }] } };
    if (withCost) {
      row.cost_usd = 1;                                  // ¥7.10
      row.last_turn.cost_usd = 0.5;                      // ¥3.55
      row.models = [
        { model: 'GLM-5.3', requests: 3, total: 1000, cost_usd: 0.4 },        // ¥2.84
        { model: 'claude-opus-5-5', requests: 1, total: 2000, cost_usd: 0.6 }, // ¥4.26
      ];
      row.sub = { requests: 3, total: 5000, input: 4000, output: 1000, cache_read: 3000, reasoning: 100,
        cache_write: 50, active: false, rate_avg: 90, cost_usd: 0.8,
        models: [{ model: 'GLM-5.3-FlashX', requests: 3, total: 5000, cost_usd: 0.8 }], list: [] };
      row.project = { sessions: 2, turns: 5, requests: 9, input: 50000, output: 6000, reasoning: 400,
        cache_read: 40000, cache_write: 200, total: 56000, tool_calls: 2, retries: 1,
        started: NOW - 120000, last_at: NOW - 1000, cost_usd: 3,             // ¥21.30
        name: 'zcode-token-usage-statusbar',
        models: [{ model: 'GLM-5.3', requests: 8, total: 3000, cost_usd: 3 }] };
    }
    const out = { remote_evidence: false, not_local: [], recent: [row], last: row.last,
      today: { requests: 10, input: 90000, output: 8000, cache_read: 80000, total: 98000,
        reasoning: 500, retries: 1, cache_write: 300, started: NOW - 60000, last_at: NOW - 1000 } };
    if (withCost && todayCost !== null) {
      out.today.cost_usd = todayCost;
      out.today.models = [{ model: 'GLM-5.3-FlashX', requests: 40, total: 98000, cost_usd: todayCost }];
    }
    if (fx !== null) out.fx = fx;
    return out;
  }
  const tipRoot = () => body.children.find(e => e.className === 'tip zusage-tip-root');
  const tips = () => window.__zuTips || [];
  function drawProjectTip() {   // 真实 drawTip 路径：按内容标记定位项目格（不依赖格序），写入 tip 元素返回内容串
    const idx = tips().findIndex(x => String(x).indexOf('zu-project-tip') > 0);
    assert.ok(idx >= 0, 'project tip present in tips');
    const tip = tipRoot();
    if (!tip.children.length) {
      const tbody = new Element('div'); tbody.className = 'tbody';
      tip.appendChild(tbody);
    }
    tip.__tip = tips()[idx];
    window.__zuDrawTip(tip, false);
    return tip.firstChild.innerHTML;
  }
  function clickMore(html) {
    const tip = tipRoot();
    if (!tip.children.length) {
      const tbody = new Element('div'); tbody.className = 'tbody';
      tip.appendChild(tbody);
    }
    const key = html.match(/data-key="([^"]+)"/)[1];
    const rowsEl = new Element(); rowsEl.setAttribute('data-zu-pj-rows', '1');
    const rootEl = new Element(); rootEl.queries.set('[data-zu-pj-rows]', rowsEl);
    const pjBtn = new Element('button');
    pjBtn.setAttribute('data-key', key);
    pjBtn.closest = sel => (sel === '.zu-project-tip' ? rootEl : null);
    const fakeTarget = { closest: sel => (sel === '.zu-pj-more' ? pjBtn : null) };
    tip.listeners.get('click')[0]({ target: fakeTarget, stopPropagation() {} });
    return { rowsEl, pjBtn };
  }
  return { window, body, inject, tick, boot, buildComposer, payload, tipRoot, tips, store, drawProjectTip, clickMore };
}

function setup(h) {
  h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
}

function withProjectModels(h, models, extra) {
  const p = h.payload(Object.assign({ withCost: models !== undefined }, extra || {}));
  if (models === undefined) { delete p.recent[0].project.models; }
  else { p.recent[0].project.models = models; }
  h.window.__zusageUpdate(p);
  return p;
}


test('默认 6 项折叠：N=12 显 6 行 + 查看全部按钮；展开为 12 行；收起恢复；aria 同步；刷新不折回', () => {
  console.error('CASE1-START');
  const h = harness(); setup(h);
  console.error('CASE1-SETUP-DONE');
  const models = Array.from({ length: 12 }, (_, i) => (
    { model: 'pj-m-' + String(12 - i).padStart(2, '0'), requests: 10 - i, total: 9000 - i * 700, cost_usd: 0.5 + i * 0.1 }));
  const firstP = withProjectModels(h, models);
  const html = h.drawProjectTip();
  const bodyRows = (html.split('data-zu-pj-rows>')[1] || '').match(/<tr>/g) || [];
  assert.equal(bodyRows.length, 6);
  assert.match(html, /查看全部 12 个模型/);
  assert.match(html, /aria-expanded="false"/);
  const { rowsEl, pjBtn } = h.clickMore(html);
  assert.equal(pjBtn.getAttribute('aria-expanded'), 'true');
  assert.equal((rowsEl.innerHTML.match(/<tr>/g) || []).length, 12);
  assert.match(rowsEl.innerHTML, /pj-m-01/);
  h.window.__zusageUpdate(firstP);   // 同归属数据刷新：重发同一 payload（started 不漂移）
  assert.match(h.drawProjectTip(), /aria-expanded="true"/);
  assert.doesNotMatch(h.drawProjectTip(), /查看全部/);
  const { rowsEl: rows2, pjBtn: btn2 } = h.clickMore(h.drawProjectTip());
  assert.equal(btn2.getAttribute('aria-expanded'), 'false');
  assert.equal((rows2.innerHTML.match(/<tr>/g) || []).length, 6);
});

test('N=0/1/6/7 的按钮显隐与降级；排序副本不变异（冻结数组）', () => {
  for (const [n, hasBtn] of [[0, false], [1, false], [6, false], [7, true]]) {
    const h = harness(); setup(h);
    withProjectModels(h, Array.from({ length: n }, (_, i) => ({ model: 'x' + i, requests: 1, total: (n - i) * 10, cost_usd: 0 })));
    const html = h.drawProjectTip();
    assert.equal(/zu-pj-more/.test(html), hasBtn, 'N=' + n);
    if (n === 0) assert.doesNotMatch(html, /zu-pj-table/);
  }
  const h = harness(); setup(h);
  const frozen = Object.freeze([{ model: 'b-small', requests: 1, total: 5 }, { model: 'a-big', requests: 2, total: 999 }]);
  withProjectModels(h, frozen);
  const order = [...h.drawProjectTip().matchAll(/title="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['a-big', 'b-small']);
  assert.deepEqual(frozen.map(m => m.model), ['b-small', 'a-big']);   // 原数组未被排序修改
});

test('费用语义：0 有效、缺失显 —、开关关收 KPI 格与表格费用列；forceKmb 不影响次数列', () => {
  const h = harness(); setup(h);
  withProjectModels(h, [
    { model: 'priced', requests: 3, total: 100, cost_usd: 0 },
    { model: 'unpriced', requests: 2, total: 50 },
  ]);
  const html = h.drawProjectTip();
  console.error('YENCODE:', [...html].filter(c => c === '¥' || c === '￥').map(c => c.codePointAt(0).toString(16)).join(','));
  assert.ok(html.indexOf('priced') >= 0, 'TBODY: ' + (html.split('data-zu-pj-rows>')[1] || 'NONE').slice(0, 400));
  assert.match(html, /<td class="zu-pj-mname" title="unpriced">unpriced<\/td><td>50<\/td><td>2<\/td><td>\u2014<\/td>/);
  const h2 = harness({ kmbLS: '1' }); setup(h2);
  withProjectModels(h2, [{ model: 'k', requests: 12345, total: 1234567, cost_usd: 1 }]);
  const html2 = h2.drawProjectTip();
  assert.match(html2, /<td>1.23M<\/td>/);        // token 走强制 K/M/B
  assert.match(html2, /<td>1.23万<\/td>/);        // 次数不受 forceKmb 影响（保持万/亿口径）
  const h3 = harness({ costLS: '0' }); setup(h3);
  withProjectModels(h3, [{ model: 'k', requests: 1, total: 10, cost_usd: 1 }]);
  const html3 = h3.drawProjectTip();
  assert.doesNotMatch(html3, /预估费用/);
  assert.doesNotMatch(html3, /¥/);
});

test('归属键变化重置展开态；长模型名 title 全文；切其它格无 zu-project 残留；缺 models 降级', () => {
  const h = harness(); setup(h);
  const models = Array.from({ length: 8 }, (_, i) => ({ model: 'long-' + i, requests: 1, total: 100 - i, cost_usd: 0 }));
  withProjectModels(h, models);
  h.drawProjectTip();
  const { pjBtn } = h.clickMore(h.drawProjectTip());
  assert.equal(pjBtn.getAttribute('aria-expanded'), 'true');
  const p2 = h.payload({ withCost: true });
  p2.recent[0].project.started += 999;   // 归属键变化
  p2.recent[0].project.models = models;
  h.window.__zusageUpdate(p2);
  assert.match(h.drawProjectTip(), /aria-expanded="false"/);   // 展开态重置
  assert.match(h.drawProjectTip(), /title="long-5"/);   // 重置后折叠态：仅前 6 行
  assert.equal(h.tips().filter(x => String(x).indexOf('zu-project-tip') > 0).length, 1);   // 仅项目格一份
  const p3 = h.payload({ withCost: true });
  delete p3.recent[0].project.models;
  h.window.__zusageUpdate(p3);
  const html3 = h.drawProjectTip();
  assert.doesNotMatch(html3, /zu-pj-table/);
  assert.match(html3, /zu-pj-kpis/);
});

test('气泡上下文：项目卡 KPI ? 显示计价范围（N 个模型）；明细行 ? 显示该模型单价', () => {
  const h = harness(); setup(h);
  const tipRoot = h.tipRoot, body = h.body;
  const models = [
    { model: 'GLM-5.3-FlashX', requests: 8, total: 3000, cost_usd: 3,
      rates: { input: 0.29879, output: 1.04577, cache_read: 0.08516, cache_write: 0, key: 'glm-5.3-flashx' } },
    { model: 'gpt-6.1-sol', requests: 2, total: 800, cost_usd: 1 },
  ];
  withProjectModels(h, models);
  h.drawProjectTip();
  // KPI 的 ?（无 data-model、在卡片内）→ 计价范围行
  const kpiIcon = { getAttribute: () => null, closest: sel => (sel === '.tip-fxq' ? { getAttribute: () => null, closest: s2 => (s2 === '.zu-project-tip' ? { querySelector: () => new Element() } : null), getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 30, right: 50 }) } : (sel === '.zu-project-tip' ? { querySelector: () => new Element() } : null)) };
  tipRoot().listeners.get('mouseover')[0]({ target: kpiIcon });
  let fx = body.children.find(e => e.className.indexOf('zusage-fx-tip') >= 0);
  assert.match(fx.innerHTML, /计价范围<\/b><span>项目累计的全部 2 个模型，按各自模型价格分别计价/);
  assert.doesNotMatch(fx.innerHTML, /当前模型/);
  // 明细行的 ?（data-model=GLM-5.3-FlashX）→ 该模型单价
  const rowIcon = { closest: sel => (sel === '.tip-fxq' ? { getAttribute: k => (k === 'data-model' ? 'GLM-5.3-FlashX' : (k === 'data-rates' ? '{"input":0.29879,"output":1.04577,"cache_read":0.08516,"cache_write":0,"key":"glm-5.3-flashx"}' : null)), closest: () => null, getBoundingClientRect: () => ({ top: 200, bottom: 220, left: 30, right: 50 }) } : null) };
  tipRoot().listeners.get('mouseover')[0]({ target: rowIcon });
  fx = body.children.find(e => e.className.indexOf('zusage-fx-tip') >= 0);
  assert.match(fx.innerHTML, /模型<\/b><span>GLM-5\.3-FlashX/);
  assert.match(fx.innerHTML, /输入 ¥2\.12 · 输出 ¥7\.42 · 缓存读 ¥0\.60/);   // 单价随实时汇率折 ¥（fx 7.1）
  assert.doesNotMatch(fx.innerHTML, /计价范围/);
});

test('标题拼接项目名（v229）：pj.name 渲染 zu-pj-pname；旧快照缺字段不渲染不报错', () => {
  const h = harness(); setup(h);
  withProjectModels(h, [{ model: 'k', requests: 1, total: 10, cost_usd: 0 }]);
  assert.match(h.drawProjectTip(),
    /zu-pj-title zu-tt-name">项目累计<span class="zu-pj-pname">zcode-token-usage-statusbar<\/span><\/div>/);
  const h2 = harness(); setup(h2);
  const p = h2.payload({ withCost: true });
  delete p.recent[0].project.name;   // 旧快照/远端旧行无 name：整段不渲染
  h2.window.__zusageUpdate(p);
  assert.doesNotMatch(h2.drawProjectTip(), /zu-pj-pname/);
});

test('双语：en 标题/范围/按钮走 L() 同链；Escape keydown 委托已挂', () => {
  const h = harness(); setup(h);
  h.window.costTest.state().lang = 'en';
  withProjectModels(h, Array.from({ length: 8 }, (_, i) => ({ model: 'm' + i, requests: 1, total: 50 - i, cost_usd: 0 })));
  const html = h.drawProjectTip();
  assert.match(html, /zu-pj-title zu-tt-name">Project total</);
  assert.match(html, /zu-pj-scope">All requests</);
  assert.match(html, /Show all 8 models/);
  assert.ok(h.tipRoot().listeners.get('keydown'), 'Escape handler wired on tip');
});
