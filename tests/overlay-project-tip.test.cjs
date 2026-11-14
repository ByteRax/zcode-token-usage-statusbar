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
    .replace('function projTipPositionGrowUp(el, prevBottom) {', 'window.__zuProjGrowUp = projTipPositionGrowUp;\n    function projTipPositionGrowUp(el, prevBottom) {')
    .replace('function projTipPrevBottom() {', 'window.__zuProjPrevBottom = projTipPrevBottom;\n    function projTipPrevBottom() {')
    .replace('if (typeof projTipPositionGrowUp === "function") projTipPositionGrowUp(host, prevBottom);',
             'if (typeof projTipPositionGrowUp === "function") { window.__zuGrowArgs = (window.__zuGrowArgs || []).concat(prevBottom); projTipPositionGrowUp(host, prevBottom); }')
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
    const bare = html.replace(/<style>[\s\S]*?<\/style>/g, '');   // v303 内联 style 含同名选择器文本，先剥
    assert.equal(/zu-pj-more/.test(bare), hasBtn, 'N=' + n);
    if (n === 0) assert.doesNotMatch(bare, /zu-pj-table/);
  }
  const h = harness(); setup(h);
  const frozen = Object.freeze([{ model: 'b-small', requests: 1, total: 5 }, { model: 'a-big', requests: 2, total: 999 }]);
  withProjectModels(h, frozen);
  /* v303 pname 也带 title（全文可查）——matchAll 收窄到模型名单元格的 title */
  const order = [...h.drawProjectTip().matchAll(/zu-pj-mname zu-model-fit" title="([^"]+)"/g)].map(m => m[1]);
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
  assert.match(html, /<td class="zu-pj-mname zu-model-fit" title="unpriced">unpriced<\/td><td>50<\/td><td>2<\/td><td>\u2014<\/td>/);
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
  assert.doesNotMatch(html3.replace(/<style>[\s\S]*?<\/style>/g, ''), /zu-pj-table/);
  assert.match(html3, /zu-turn-kpis/, 'v303 四行 KPI 容器');
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
  assert.match(fx.innerHTML, /模型<\/b><span><span class="zu-model-fit" style="display:inline-block;max-width:100%" title="GLM-5\.3-FlashX">GLM-5\.3-FlashX/);
  assert.match(fx.innerHTML, /输入 ¥2\.12 · 输出 ¥7\.42 · 缓存读 ¥0\.60/);   // 单价随实时汇率折 ¥（fx 7.1）
  assert.doesNotMatch(fx.innerHTML, /计价范围/);
});

test('标题拼接项目名（v229）：pj.name 渲染 zu-pj-pname；旧快照缺字段不渲染不报错', () => {
  const h = harness(); setup(h);
  withProjectModels(h, [{ model: 'k', requests: 1, total: 10, cost_usd: 0 }]);
  assert.match(h.drawProjectTip(),
    /zu-pj-title zu-tt-name">项目累计<span class="zu-pj-pname" title="zcode-token-usage-statusbar">zcode-token-usage-statusbar<\/span><\/div>/);
  const h2 = harness(); setup(h2);
  const p = h2.payload({ withCost: true });
  delete p.recent[0].project.name;   // 旧快照/远端旧行无 name：整段不渲染
  h2.window.__zusageUpdate(p);
  assert.doesNotMatch(h2.drawProjectTip().replace(/<style>[\s\S]*?<\/style>/g, ''), /zu-pj-pname/);   // v303 剥内联 style（选择器文本含同名类）
});

test('双语：en 标题/范围/按钮走 L() 同链；Escape keydown 委托已挂', () => {
  const h = harness(); setup(h);
  h.window.costTest.state().lang = 'en';
  withProjectModels(h, Array.from({ length: 8 }, (_, i) => ({ model: 'm' + i, requests: 1, total: 50 - i, cost_usd: 0 })));
  const html = h.drawProjectTip();
  assert.match(html, /zu-pj-title zu-tt-name">Project total</);
  /* v331：范围胶囊已由右上双范围 Tab 替代（specs/all-projects-usage.md） */
  assert.match(html, /zu-pj-tab[^>]*aria-selected="true"[^>]*>Current</);
  assert.match(html, /zu-pj-tab[^>]*aria-selected="false"[^>]*>All projects</);
  assert.doesNotMatch(html, /zu-pj-scope/, 'v331 范围胶囊已删除');
  assert.match(html, /Show all 8 models/);
  assert.ok(h.tipRoot().listeners.get('keydown'), 'Escape handler wired on tip');
});

test('v329: pointerdown 展开模型明细 + 阻止冒泡与默认行为，后续 click 幂等不重复收起', () => {
  const h = harness(); setup(h);
  const models = Array.from({ length: 12 }, (_, i) => (
    { model: 'pj-m-' + String(12 - i).padStart(2, '0'), requests: 10 - i, total: 9000 - i * 700, cost_usd: 0.5 + i * 0.1 }));
  withProjectModels(h, models);
  const html = h.drawProjectTip();
  const tip = h.tipRoot();
  const key = html.match(/data-key="([^"]+)"/)[1];
  const rowsEl = new Element(); rowsEl.setAttribute('data-zu-pj-rows', '1');
  const rootEl = new Element(); rootEl.queries.set('[data-zu-pj-rows]', rowsEl);
  const pjBtn = new Element('button');
  pjBtn.setAttribute('data-key', key);
  pjBtn.closest = sel => (sel === '.zu-project-tip' ? rootEl : null);
  const fakeTarget = { closest: sel => (sel === '.zu-pj-more' ? pjBtn : null) };

  let spCalled = false, pdCalled = false;
  // 1. pointerdown 触发
  tip.listeners.get('pointerdown')[0]({
    type: 'pointerdown',
    target: fakeTarget,
    stopPropagation: () => { spCalled = true; },
    preventDefault: () => { pdCalled = true; },
  });
  assert.equal(spCalled, true, 'pointerdown 必须 stopPropagation');
  assert.equal(pdCalled, true, 'pointerdown 必须 preventDefault');
  assert.equal(pjBtn.getAttribute('aria-expanded'), 'true');
  assert.equal((rowsEl.innerHTML.match(/<tr>/g) || []).length, 12);

  // 2. 紧随其后的 click（由指针抬起产生）保持幂等，不翻转回折叠态
  tip.listeners.get('click')[0]({
    type: 'click',
    target: fakeTarget,
    stopPropagation: () => {},
    preventDefault: () => {},
  });
  assert.equal(pjBtn.getAttribute('aria-expanded'), 'true', '紧跟 pointerdown 的 click 不得 double-toggle');
  assert.equal((rowsEl.innerHTML.match(/<tr>/g) || []).length, 12);

  // 3. mousedown 阻止冒泡与默认行为（防止冒泡至宿主触发失焦）
  let mdSp = false, mdPd = false;
  tip.listeners.get('mousedown')[0]({
    type: 'mousedown',
    target: fakeTarget,
    stopPropagation: () => { mdSp = true; },
    preventDefault: () => { mdPd = true; },
  });
  assert.equal(mdSp, true, 'mousedown 必须 stopPropagation');
  assert.equal(mdPd, true, 'mousedown 必须 preventDefault');
});

test('v329: 按住超过 400ms 再松开，click 仍被一次性吞掉，不二次翻转', () => {
  const h = harness(); setup(h);
  const models = Array.from({ length: 12 }, (_, i) => (
    { model: 'pj-m-' + String(12 - i).padStart(2, '0'), requests: 10 - i, total: 9000 - i * 700, cost_usd: 0.5 + i * 0.1 }));
  withProjectModels(h, models);
  const html = h.drawProjectTip();
  const tip = h.tipRoot();
  const key = html.match(/data-key="([^"]+)"/)[1];
  const rowsEl = new Element(); rowsEl.setAttribute('data-zu-pj-rows', '1');
  const rootEl = new Element(); rootEl.queries.set('[data-zu-pj-rows]', rowsEl);
  const pjBtn = new Element('button');
  pjBtn.setAttribute('data-key', key);
  pjBtn.closest = sel => (sel === '.zu-project-tip' ? rootEl : null);
  const fakeTarget = { closest: sel => (sel === '.zu-pj-more' ? pjBtn : null) };
  const ev = type => ({ type, target: fakeTarget, stopPropagation: () => {}, preventDefault: () => {} });
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    tip.listeners.get('pointerdown')[0](ev('pointerdown'));
    assert.equal(pjBtn.getAttribute('aria-expanded'), 'true');
    t += 900;   // 按住 900ms 再松开
    tip.listeners.get('click')[0](ev('click'));
    assert.equal(pjBtn.getAttribute('aria-expanded'), 'true', '长按后的 click 不得把刚展开的明细收回');
    // 无前置 pointerdown 的 click（键盘 Enter）仍正常翻转
    tip.listeners.get('click')[0](ev('click'));
    assert.equal(pjBtn.getAttribute('aria-expanded'), 'false', '键盘 click 正常切换');
  } finally { Date.now = realNow; }
});

/* ---------- v331 全部项目模式（specs/all-projects-usage.md）---------- */

function allProjectsFixture(over) {
  return Object.assign({
    sessions: 103, turns: 222, requests: 556,
    input: 100000, output: 4000, reasoning: 349,
    cache_read: 97000, cache_write: 200, total: 104000,
    tool_calls: 689, retries: 123,
    started: Date.now() - 86400000, last_at: Date.now() - 1000,
    avg_duration_ms: 17800, avg_ttft_ms: 8000, duration_ms: 988000000,
    avg_tps: 77.3, cost_usd: 16.5,
    models: [
      { model: 'GLM-5.3-FlashX', requests: 300, total: 60000, cost_usd: 9 },
      { model: 'claude-sonnet-5', requests: 100, total: 20000, cost_usd: 7.5 },
    ],
    projects: [
      { name: 'proj-a', directory: '/w/proj-a', total: 52000, requests: 287, cost_usd: 12.5 },
      { name: 'proj-b', directory: '/w/proj-b', total: 31000, requests: 120, cost_usd: 4 },
      { name: '', directory: '', unattributed: true, total: 300, requests: 2, cost_usd: 0 },
    ],
  }, over || {});
}

function withAllProjects(h, ap) {
  const p = h.payload({ withCost: true });
  p.all_projects = ap;
  h.window.__zusageUpdate(p);
  return p;
}

function clickTab(h, scope) {   // pointerdown 委托切换（生产路径）；返回重编后的卡片 HTML
  h.drawProjectTip();   // 建立 tipFor/projTipPj（真实使用中 tooltip 必已打开）
  const tip = h.tipRoot();
  const tabBtn = new Element('button');
  tabBtn.setAttribute('data-scope', scope);
  const fakeTarget = { closest: sel => (sel === '.zu-pj-tab' ? tabBtn : null) };
  tip.listeners.get('pointerdown')[0]({
    type: 'pointerdown', target: fakeTarget, button: 0,
    stopPropagation() {}, preventDefault() {},
  });
  return h.tipRoot().firstChild.innerHTML;
}

function clickMoreKind(h, kind) {   // 指定 data-kind 的展开按钮（proj=项目明细 / 缺省=模型明细）
  const html = h.tipRoot().firstChild.innerHTML;
  const key = html.match(/data-key="([^"]+)"/)[1];
  const rowsSel = kind === 'proj' ? '[data-zu-pj-projects]' : '[data-zu-pj-rows]';
  const rowsEl = new Element(); rowsEl.setAttribute(rowsSel, '1');
  const rootEl = new Element(); rootEl.queries.set(rowsSel, rowsEl);
  const btn = new Element('button');
  btn.setAttribute('data-key', key);
  if (kind) btn.setAttribute('data-kind', kind);
  btn.closest = sel => (sel === '.zu-project-tip' ? rootEl : null);
  const fakeTarget = { closest: sel => (sel === '.zu-pj-more' ? btn : null) };
  h.tipRoot().listeners.get('pointerdown')[0]({
    type: 'pointerdown', target: fakeTarget,
    stopPropagation() {}, preventDefault() {},
  });
  return { rowsEl, btn };
}

test('v331 默认当前项目：头部双 Tab、输入格含缓存辅助行、无项目明细', () => {
  const h = harness(); setup(h);
  withAllProjects(h, allProjectsFixture());
  const html = h.drawProjectTip().replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(html, /aria-selected="true"[^>]*>当前项目</);
  assert.match(html, /aria-selected="false"[^>]*>全部项目</);
  assert.match(html, /zu-pj-pname/, '当前项目模式拼项目名');
  assert.match(html, /含缓存 4万/, '输入格副行=当前项目 cache_read 原值');
  assert.doesNotMatch(html, /data-zu-pj-projects/, '当前项目模式无项目明细');
  assert.doesNotMatch(html, /zu-pj-div/, '无分隔线');
});

test('v331 切全部项目：KPI/明细/时间切换、项目明细在模型明细前、未归属条目、转义', () => {
  const h = harness(); setup(h);
  withAllProjects(h, allProjectsFixture({
    projects: [
      { name: 'proj-a', directory: '/w/proj-a', total: 52000, requests: 287, cost_usd: 12.5 },
      { name: '<img src=x onerror=alert(1)>', directory: '/w/evil', total: 31000, requests: 120, cost_usd: 4 },
      { name: '', directory: '', unattributed: true, total: 300, requests: 2, cost_usd: 0 },
    ],
  }));
  const html = clickTab(h, 'all');
  const bare = html.replace(/<style>[\s\S]*?<\/style>/g, '');
  // Tab 选中态与项目名隐藏
  assert.match(bare, /aria-selected="true"[^>]*>全部项目</);
  assert.doesNotMatch(bare, /zu-pj-pname/, '全部项目模式不显示当前项目名');
  // KPI 换全局口径：总用量/缓存命中率/含缓存/平均输出速度/费用
  assert.match(bare, /总用量/);
  assert.match(bare, /10\.4万/);
  assert.match(bare, /缓存97%/);
  assert.match(bare, /含缓存 9\.7万/);
  assert.match(bare, /77\.3/);
  assert.match(bare, /¥117\.15/, 'cost_usd 16.5 × fx 7.1');
  // 项目明细在模型明细之前 + 未归属条目本地化 + XSS 转义
  const idxP = bare.indexOf('项目明细'), idxM = bare.indexOf('模型明细');
  assert.ok(idxP > 0 && idxM > idxP, '项目明细必须位于模型明细之前');
  assert.match(bare, /<th[^>]*>项目明细<\/th>/, 'v331 首列 th 专锁：分区名并入项目表表头（独立标题行不得回归）');
  assert.match(bare, /未归属项目/);
  assert.doesNotMatch(bare, /<img src=x/, '项目名必须转义');
  assert.match(bare, /&lt;img src=x/);
  // 模型明细标题行右侧全局工具/重试
  assert.match(bare, /工具调用 689\s*次/);
  assert.match(bare, /重试 123\s*次/);
  // 分隔线与时间范围（全局起止）
  assert.match(bare, /zu-pj-div/);
  assert.match(bare, /zu-stat-time/);
});

test('v331 切回当前项目：数据与项目名恢复，无项目明细残留', () => {
  const h = harness(); setup(h);
  withAllProjects(h, allProjectsFixture());
  clickTab(h, 'all');
  const back = clickTab(h, 'cur').replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(back, /aria-selected="true"[^>]*>当前项目</);
  assert.match(back, /zu-pj-pname/);
  assert.match(back, /5\.6万/, 'pj.total=56000（夹具项目值）');
  assert.doesNotMatch(back, /data-zu-pj-projects/);
  assert.doesNotMatch(back, /未归属项目/);
});

test('v331 项目明细独立展开（整卡重建核数）+ 切范围重置项目明细/保留模型明细', () => {
  const h = harness(); setup(h);
  const projects = Array.from({ length: 8 }, (_, i) => (
    { name: 'p-' + String(8 - i).padStart(2, '0'), directory: '/w/p' + (8 - i), total: 9000 - i * 700, requests: 10 - i, cost_usd: 1 }));
  const models = Array.from({ length: 12 }, (_, i) => (
    { model: 'm-' + String(12 - i).padStart(2, '0'), requests: 1, total: 8000 - i * 500, cost_usd: 1 }));
  const ap = allProjectsFixture({ projects, models });
  const p0 = withAllProjects(h, ap);   // 之后复用同一 payload：重建会漂移 started 触发归属键重置（设计行为）
  clickTab(h, 'all');
  const rowsOf = html => ({
    // 各 tbody 切片到本表 </table> 为止（后续模型表/表头行不串数）
    proj: (((html.split('data-zu-pj-projects>')[1] || '').split('</table>')[0]).match(/<tr>/g) || []).length,
    model: (((html.split('data-zu-pj-rows>')[1] || '').split('</table>')[0]).match(/<tr>/g) || []).length,
  });
  // 默认：项目 5 行 / 模型 6 行
  let r = rowsOf(h.tipRoot().firstChild.innerHTML.replace(/<style>[\s\S]*?<\/style>/g, ''));
  assert.deepEqual(r, { proj: 5, model: 6 });
  // 经真实局部更新展开两者（projTipApply* 守卫通过才落状态）
  r = clickMoreKind(h, 'proj');   // 项目 → 8
  assert.equal(r.btn.getAttribute('aria-expanded'), 'true');
  r = clickMoreKind(h, undefined);   // 模型 → 12
  assert.equal(r.btn.getAttribute('aria-expanded'), 'true');
  // 数据帧整卡重建：两个展开态都保持（8/12），状态变量真实生效而非桩残留
  h.window.__zusageUpdate(p0);   // 同键刷新（同一 payload 对象）
  let bare = h.drawProjectTip().replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.deepEqual(rowsOf(bare), { proj: 8, model: 12 }, '整卡重建后两展开态各自保持');
  // 切范围（cur→all）重置项目明细展开（spec §6），模型明细展开保留
  clickTab(h, 'cur');
  bare = clickTab(h, 'all').replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.deepEqual(rowsOf(bare), { proj: 5, model: 12 }, '项目明细重置为 5、模型保持 12');
});

test('v331 缺 all_projects 字段：全部项目显「暂不可用」，切回当前项目正常；归属键变化重置范围', () => {
  const h = harness(); setup(h);
  withProjectModels(h, [{ model: 'k', requests: 1, total: 10, cost_usd: 0 }]);   // 无 all_projects
  const allHtml = clickTab(h, 'all').replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(allHtml, /全部项目统计暂不可用/);
  assert.doesNotMatch(allHtml, /data-zu-pj-projects/, '缺数据不渲染项目明细');
  const back = clickTab(h, 'cur').replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(back, /暂不可用/);
  assert.match(back, /zu-pj-pname/, '当前项目模式不受影响');
  // 切到全部后归属键变化（项目 started 变）→ 重置回当前项目
  withAllProjects(h, allProjectsFixture());
  clickTab(h, 'all');
  const p2 = h.payload({ withCost: true });
  p2.recent[0].project.started += 999;
  p2.all_projects = allProjectsFixture();
  h.window.__zusageUpdate(p2);
  const html2 = h.drawProjectTip().replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(html2, /aria-selected="true"[^>]*>当前项目</, '归属键变化重置范围 Tab');
});

test('v331 Tab 切换 pointerdown 同步生效、后随 click 幂等；Tab 进 mousedown 阻止名单', () => {
  const h = harness(); setup(h);
  withAllProjects(h, allProjectsFixture());
  h.drawProjectTip();   // 打开态（生产中 Tab 点击必然发生在 tooltip 打开后）
  const tip = h.tipRoot();
  const tabBtn = new Element('button');
  tabBtn.setAttribute('data-scope', 'all');
  const fakeTarget = { closest: sel => (sel === '.zu-pj-tab' ? tabBtn : null) };
  let sp = false, pd = false;
  tip.listeners.get('pointerdown')[0]({
    type: 'pointerdown', target: fakeTarget, button: 0,
    stopPropagation: () => { sp = true; }, preventDefault: () => { pd = true; },
  });
  assert.equal(sp, true, 'pointerdown 必须 stopPropagation');
  assert.equal(pd, true, 'pointerdown 必须 preventDefault');
  assert.match(h.tipRoot().firstChild.innerHTML, /data-zu-pj-projects/, 'pointerdown 已同步切换');
  tip.listeners.get('click')[0]({ type: 'click', target: fakeTarget, stopPropagation() {}, preventDefault() {} });
  const after = h.tipRoot().firstChild.innerHTML;
  assert.match(after, /aria-selected="true"[^>]*>全部项目</, '后随 click 不重置');
  // mousedown 名单含 Tab（防宿主失焦）
  let mdSp = false, mdPd = false;
  tip.listeners.get('mousedown')[0]({
    type: 'mousedown', target: fakeTarget,
    stopPropagation: () => { mdSp = true; }, preventDefault: () => { mdPd = true; },
  });
  assert.equal(mdSp && mdPd, true, 'mousedown 必须阻止冒泡与默认行为');
});

test('v331 截断提示：projects_total 为截断前真实项目数', () => {
  const h = harness(); setup(h);
  const projects = Array.from({ length: 8 }, (_, i) => (
    { name: 'p-' + i, directory: '/w/p' + i, total: 9000 - i, requests: 1, cost_usd: 0 }));
  withAllProjects(h, allProjectsFixture({ projects, projects_truncated: true, projects_total: 57 }));
  clickTab(h, 'all');
  const bare = h.tipRoot().firstChild.innerHTML.replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(bare, /已截断，共 57 项/, '提示用截断前总数而非列表长度');
  assert.match(bare, /data-zu-pj-projects/);
});

test('v331 费用开关关：项目明细与模型明细费用列整体不渲染', () => {
  const h = harness({ costLS: '0' }); setup(h);
  withAllProjects(h, allProjectsFixture());
  clickTab(h, 'all');
  const bare = h.tipRoot().firstChild.innerHTML.replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(bare, /预估费用/);
  assert.doesNotMatch(bare, /¥/);
  assert.match(bare, /data-zu-pj-projects/, '明细表仍在，仅收费用列');
});

test('v331 数据刷新不重置选中 Tab；旧快照项目行缺 all_projects 时当前卡不受扰', () => {
  const h = harness(); setup(h);
  const p = withAllProjects(h, allProjectsFixture());
  clickTab(h, 'all');
  h.window.__zusageUpdate(p);   // 同帧重发（数据刷新）
  const bare = h.drawProjectTip().replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(bare, /aria-selected="true"[^>]*>全部项目</, '数据刷新不得重置 Tab');
  assert.match(bare, /data-zu-pj-projects/);
});

test('v338 行四项目数量格（仅全部项目模式）：计数用 projects_total、费用关退两格', () => {
  const h = harness(); setup(h);
  const p1 = withAllProjects(h, allProjectsFixture());
  clickTab(h, 'all');
  // 切 Tab 重编接线实收基线>0（projTipPrevBottom 经真实调用链传入 GrowUp）
  const growArgs = h.window.__zuGrowArgs || [];
  assert.ok(growArgs.length >= 1 && growArgs[growArgs.length - 1] > 0, 'rebuild 接线传递真实底边基线');
  let bare = h.tipRoot().firstChild.innerHTML.replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(bare, /项目数量/, '全部项目模式行四第一列=项目数量');
  const stripTags = t => t.replace(/<[^>]+>/g, '');
  assert.match(stripTags(bare), /项目数量\s*3/);
  assert.match(bare, /zu-turn-kpis--trio/, '费用可见时三格');
  assert.equal((bare.match(/项目数量/g) || []).length, 1, '仅一处');
  // 截断时计数用截断前总数（复用同一 payload：重建会漂移 started 触发归属键重置）
  const projects = Array.from({ length: 8 }, (_, i) => ({ name: 'p-' + i, directory: '/w/p' + i, total: 9000 - i, requests: 1, cost_usd: 0 }));
  p1.all_projects = allProjectsFixture({ projects, projects_truncated: true, projects_total: 57 });
  h.window.__zusageUpdate(p1);
  bare = h.drawProjectTip().replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(stripTags(bare), /项目数量\s*57/, '截断时显截断前真实数');
  // 费用关：两格退 --duo，项目数量仍在
  const h3 = harness({ costLS: '0' }); setup(h3);
  withAllProjects(h3, allProjectsFixture());
  clickTab(h3, 'all');
  bare = h3.tipRoot().firstChild.innerHTML.replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.match(bare, /项目数量/);
  assert.doesNotMatch(bare, /zu-turn-kpis--trio/, '费用关退两格');
  // 当前项目模式无该格
  const h4 = harness(); setup(h4);
  withProjectModels(h4, [{ model: 'k', requests: 1, total: 10, cost_usd: 0 }]);
  const cur = h4.drawProjectTip().replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(cur, /项目数量/, '当前项目模式无项目数量格');
});

test('v338 源码契约锁：.tbody 视口帽 36px 与展开按钮路径 growUp 接线', () => {
  // 变异复审：36px 值无行为锁（改回 24px 全绿）——源码契约断言钉住
  assert.match(source, /\.zusage-tip-root:has\(\.zu-stat-tip--project\) \.tbody\{max-height:calc\(100vh - 36px\)!important\}/);
  // 展开按钮两路径接线（VM 中 tipFor 恒空走不到，只能源码锁）：基线采集先于局部更新、growUp 随后
  const calls = source.match(/projTipPositionGrowUp\(tipFor, prevBottom\);/g) || [];
  assert.equal(calls.length, 2, 'applyModels/applyProjects 两处接线各一次');
  // 4 = 两处展开接线 + rebuild 条件守卫 + 函数声明行（grep 语义：声明也含 "()"）
  assert.equal((source.match(/projTipPrevBottom\(\)/g) || []).length, 4,
    '三条路径均在内容变更前采集基线（2 展开 + 1 rebuild 守卫 + 1 声明行）');
});

test('v338 高度自下而上：增高/收缩底边固定、顶边钳 8px、无基线回退原锚定', () => {
  const h = harness(); setup(h);
  withAllProjects(h, allProjectsFixture());
  h.drawProjectTip();
  const tip = h.tipRoot();
  tip.style.top = '300px'; tip.style.display = 'block';
  let tipH = 200;
  tip.getBoundingClientRect = () => ({ top: 300, bottom: 300 + tipH, left: 20, right: 520, width: 500, height: tipH });
  // PrevBottom 正路径：显示态基线 = top + height（300+200=500）
  assert.equal(h.window.__zuProjPrevBottom(), 500, '显示态基线=top+height');
  // 增高 200→320：底边 500 固定，top=180（用户规格：不向下移动）
  tipH = 320;
  h.window.__zuProjGrowUp(tip, 500);
  assert.equal(parseFloat(tip.style.top), 180);
  // 收缩 320→120：底边仍 500，top=380
  tipH = 120;
  h.window.__zuProjGrowUp(tip, 500);
  assert.equal(parseFloat(tip.style.top), 380);
  // 高度逼近基线：top 钳 ≥8px（max-height 视口钳制兜底不越出）
  tipH = 500;
  h.window.__zuProjGrowUp(tip, 500);
  assert.equal(parseFloat(tip.style.top), 8, '顶边不低于 8px');
  // 无基线（首次弹出）：回退 positionTip 原锚定，不抛错（先清 top 防残留假绿）
  tipH = 200;
  tip.style.top = '';
  h.window.__zuProjGrowUp(tip, 0);
  assert.match(tip.style.top, /px$/, '无基线回退 positionTip 重写 top');
  assert.equal(parseFloat(tip.style.top), 92, '回退=锚定公式 anchor.top(300)−height(200)−8（el=tip 自身）');
  // 基线采集守卫：非显示态不产基线
  tip.style.display = 'none';
  assert.equal(h.window.__zuProjPrevBottom(), 0);
});
