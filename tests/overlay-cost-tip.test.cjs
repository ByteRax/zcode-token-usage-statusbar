const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v202 预估费用：四格 tooltip 费用行/模型明细费用/来源脚注/紧凑摘要（overlay-quota-chip 同款夹具）。
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

function harness({ costLS = null } = {}) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  window.__zusagePluginState = {};
  const store = new Map();
  if (costLS !== null) store.set('zusage3.cost', costLS);
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
    .replace(/\}\)\(\);\s*$/, 'window.costTest = { state: function() { return state; } };})();');
  function inject() { window.__zusageOverlay = false; if (!globalThis.__dump2) { globalThis.__dump2 = 1; fs.writeFileSync('/tmp/exe-ct.js', executable); } vm.runInContext(executable, sandbox); }
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
        models: [{ model: 'GLM-5.3-FlashX', requests: 2, total: 5800, cost_usd: 0.5,
          rates: { input: 0.29879, output: 1.04577, cache_read: 0.08516, cache_write: 0, key: 'glm-5.3-flashx' } }] } };
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
        models: [{ model: 'GLM-5.3', requests: 8, total: 3000, cost_usd: 3 }] };
    }
    const out = { remote_evidence: false, not_local: [], recent: [row], last: row.last,
      today: { requests: 10, input: 90000, output: 8000, cache_read: 80000, total: 98000,
        reasoning: 500, retries: 1, cache_write: 300, started: NOW - 60000, last_at: NOW - 1000 } };
    if (withCost && todayCost !== null) {
      out.today.cost_usd = todayCost;
      out.today.models = [{ model: 'GLM-5.3-FlashX', requests: 40, total: 98000, cost_usd: todayCost,
        rates: { input: 0.29879, output: 1.04577, cache_read: 0.08516, cache_write: 0, key: 'glm-5.3-flashx' } }];
    }
    if (fx !== null) out.fx = fx;
    return out;
  }
  const tipRoot = () => body.children.find(e => e.className === 'tip zusage-tip-root');
  const fxTipEl = () => body.children.find(e => e.className === 'tip zusage-quota-tip zusage-fx-tip');
  function hoverFxq(h, enter = true, attrs = null) {
    const tip = tipRoot();
    /* v248：icon 目标带 getAttribute（真实链路从渲染出的 data-* 属性取模型上下文） */
    const target = { getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 30, right: 50 }),
      getAttribute: k => (attrs && Object.prototype.hasOwnProperty.call(attrs, k)) ? String(attrs[k]) : null };
    const icon = { closest: sel => sel === '.tip-fxq' ? target : null };
    const evts = tip.listeners.get(enter ? 'mouseover' : 'mouseout');
    evts[0]({ target: icon, relatedTarget: null });
  }
  const tips = () => window.__zuTips || [];
  return { window, body, inject, tick, boot, buildComposer, payload, tipRoot, fxTipEl, hoverFxq, tips, store };
}

function setup(h) {
  h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
}

const ALL_TIPS_HAS_COST = /预估费用<\/b><span>/;

/* v248：从渲染出的 tooltip HTML 提取 KPI 费用问号 icon 的 data-* 属性（escAttr 转义还原），
 * 喂给 hoverFxq 走真实委托链（icon 属性 → 分派 → fxTipHTML） */
const unescAttr = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function fxqAttrs(tipHtml, label = '预估费用') {
  const m = tipHtml.match(new RegExp(label + '<svg class="tip-fxq"([^>]*)>'));
  if (!m) throw new Error('fxq icon not found after ' + label);
  const attrs = {};
  for (const [, k, v] of m[1].matchAll(/(data-[\w-]+)="([^"]*)"/g)) attrs[k] = unescAttr(v);
  return attrs;
}

test('四格 tooltip 显示 ¥ 费用行、模型明细费用与可点来源脚注（fx 生效）', () => {
  const h = harness(); setup(h);
  h.window.__zusageUpdate(h.payload({}));
  const tips = h.tips();
  // 本轮（tips[0]，v215 卡）：KPI 费用 + 模型明细表格（v253 改项目卡式四列表，行式 rt-models 退役）
  assert.match(tips[0], /预估费用<svg class="tip-fxq"[^]*?zu-stat-v">¥3\.55<\/div>/);
  assert.match(tips[0], /zu-pj-mhead[^]*?模型明细[^]*?zu-stat-table/);
  assert.match(tips[0], /<td class="zu-pj-mname zu-model-fit" title="GLM-5\.3-FlashX">GLM-5\.3-FlashX<\/td><td>5800<\/td><td>2<\/td><td>¥3\.55<\/td>/);
  assert.doesNotMatch(tips[0], /rt-models/);
  assert.doesNotMatch(tips[0], /价格来源/);   // 底部来源脚注已移除（信息收进气泡）
  // 会话累计（tips[1]，v215 卡）：KPI 费用 + 模型表格行费用
  assert.match(tips[1], /zu-stat-tip--session/);
  assert.match(tips[1], /预估费用<svg class="tip-fxq"[^]*?zu-stat-v">¥7\.10<\/div>/);
  assert.match(tips[1], /<thead><tr><th>模型<\/th><th>Token 用量 ↓<\/th><th>请求次数<\/th><th>预估费用<\/th><\/tr><\/thead>/);
  assert.match(tips[1], /<td class="zu-pj-mname zu-model-fit" title="GLM-5\.3">GLM-5\.3<\/td><td>1000<\/td><td>3<\/td><td>¥2\.84<\/td>/);
  assert.match(tips[1], /<td class="zu-pj-mname zu-model-fit" title="claude-opus-5-5">claude-opus-5-5<\/td><td>2000<\/td><td>1<\/td><td>¥4\.26<\/td>/);
  // 今日合计（tips[2]，v301 三行 KPI 卡）：输入列缓存副行 + 费用 KPI + 模型明细表格（v253）
  assert.match(tips[2], /缓存命中率/);
  assert.match(tips[2], /预估费用<svg class="tip-fxq"[^]*?zu-stat-v">¥14\.20<\/div>/);
  assert.match(tips[2], /zu-pj-mhead[^]*?模型明细[^]*?zu-stat-table/);
  assert.match(tips[2], /<td class="zu-pj-mname zu-model-fit" title="GLM-5\.3-FlashX">GLM-5\.3-FlashX<\/td><td>9\.8万<\/td><td>40<\/td><td>¥14\.20<\/td>/);
  assert.doesNotMatch(tips[2], /价格来源/);
  // 项目累计（tips[3]，v214 统计卡）
  assert.match(tips[3], /zu-stat-tip--project" data-key="sid_main:/);   // v303 根类并入统计卡家族
  assert.match(tips[3], /<td class="zu-pj-mname zu-model-fit" title="GLM-5\.3">GLM-5\.3<\/td><td>3000<\/td><td>8<\/td><td>¥21\.30<\/td>/);
  // 子代理格（tips[5]，v217）：__tip 置空——汇总/费用迁入统一浮层（.zu-sub-pop），不走通用 tooltip
  assert.equal(tips[5], null);
});

test('v253 本轮/今日模型明细表：多模型按 Token 用量降序渲染、缺价模型显 "—" 不显假 0', () => {
  const h = harness(); setup(h);
  const p = h.payload({});
  p.today.models = [{ model: 'claude-opus-5-5', requests: 5, total: 3000 },   // 升序输入：渲染层必须重排；缺 cost_usd 显 "—"
    { model: 'GLM-5.3-FlashX', requests: 40, total: 98000, cost_usd: 2,
      rates: { input: 0.29879, output: 1.04577, cache_read: 0.08516, cache_write: 0, key: 'glm-5.3-flashx' } }];
  p.recent[0].last_turn.models = [{ model: 'GLM-5.3-FlashX', requests: 1, total: 1800, cost_usd: 0.5 },
    { model: 'claude-opus-5-5', requests: 1, total: 4000 }];   // 升序输入，验证渲染层降序（4000 行先）
  h.window.__zusageUpdate(p);
  const tips = h.tips();
  // 今日：渲染重排后 9.8万 行在前、3000 行在后；缺价模型费用 "—"
  assert.match(tips[2], /¥14\.20<\/td><\/tr><tr><td class="zu-pj-mname zu-model-fit" title="claude-opus-5-5">claude-opus-5-5<\/td><td>3000<\/td><td>5<\/td><td>—<\/td><\/tr>/);
  // 本轮：升序输入（1800 在前、4000 在后）渲染为降序（4000 行先），各自费用 — / ¥3.55
  assert.match(tips[0], /<td class="zu-pj-mname zu-model-fit" title="claude-opus-5-5">claude-opus-5-5<\/td><td>4000<\/td><td>1<\/td><td>—<\/td><\/tr><tr><td class="zu-pj-mname zu-model-fit" title="GLM-5\.3-FlashX">GLM-5\.3-FlashX<\/td><td>1800<\/td><td>1<\/td><td>¥3\.55<\/td><\/tr>/);
  // 空数组：整块不渲染（含表格骨架也不出；v301 今日卡内联 style 含同名选择器文本，先剥 style）
  p.today.models = [];
  h.window.__zusageUpdate(p);
  assert.doesNotMatch(h.tips()[2].replace(/<style>[\s\S]*?<\/style>/g, ''), /zu-stat-table|模型明细/);
});

test('无 fx 汇率时诚实降级 $ 原值，脚注标 USD', () => {
  const h = harness(); setup(h);
  h.window.__zusageUpdate(h.payload({ fx: null }));
  const tips = h.tips();
  assert.match(tips[1], /预估费用<svg class="tip-fxq"[^]*?zu-stat-v">\$1\.00<\/div>/);
  assert.match(tips[2], /预估费用<svg class="tip-fxq"[^]*?zu-stat-v">\$2\.00<\/div>/);   // v213 格序：今日合计 tips[2]
  assert.doesNotMatch(tips[1], /价格来源/);
});

test('会话累计标题拼接会话名（v230）：title 渲染 zu-st-name、空白压缩单空格；旧快照缺字段不渲染', () => {
  const h = harness(); setup(h);
  const p = h.payload({});
  p.recent[0].title = '  修复\n登录页   空白与超长的会话标题应当被省略号截断而不撑破卡片布局  ';
  h.window.__zusageUpdate(p);
  assert.match(h.tips()[1],
    /zu-stat-title zu-tt-name">会话累计<span class="zu-st-name">修复 登录页 空白与超长的会话标题应当被省略号截断而不撑破卡片布局<\/span>/);
  const h2 = harness(); setup(h2);
  h2.window.__zusageUpdate(h2.payload({}));   // 夹具 row 无 title（旧快照形态）：整段不渲染
  assert.doesNotMatch(h2.tips()[1], /zu-st-name/);
});

test('旧快照（无 cost_usd/fx 字段）不显费用行，不显假 0', () => {
  const h = harness(); setup(h);
  h.window.__zusageUpdate(h.payload({ withCost: false, todayCost: null }));
  // v217：子代理格 tip 为 null（统一浮层承接），遍历时跳过
  for (const t of h.tips()) { if (!t) continue; assert.doesNotMatch(t, /预估费用<svg|预估费用<\/b>/); }   // KPI 标签也随项目卡骨架存在——只禁 KPI/行费用形态
  // v253 review：today.models 未注入（旧快照形态）→ 今日模型明细整块不渲染（空态守卫；
  // v301 今日卡内联 style 含 zu-pj-mhead 选择器文本，先剥 style 再断言）
  assert.doesNotMatch(h.tips()[2].replace(/<style>[\s\S]*?<\/style>/g, ''), /模型明细|zu-pj-mhead/);
});

test('⚙ 开关关闭（zusage3.cost=0）后四格均无费用行与脚注', () => {
  const h = harness({ costLS: '0' }); setup(h);
  assert.equal(h.window.costTest.state().cost, 0);
  h.window.__zusageUpdate(h.payload({}));
  for (const t of h.tips()) {
    if (!t) continue;   // v217：子代理格 tip 为 null
    assert.doesNotMatch(t, /预估费用<\/b>/);   // rt-row 费用行全部不渲染
    assert.doesNotMatch(t, /价格来源 models\.dev/);
  }
  assert.doesNotMatch(h.tips()[3], /预估费用/);   // 项目卡 KPI 格与表格费用列整体不渲染
  assert.match(h.tips()[3], /<th>[^<]*<\/th><\/tr><\/thead>/);   // 表头收为三列
  // v253 review：本轮/今日模型表头精确锚定三列（含 </thead> 收尾，4 列表头失配），
  // 且行内无费用 td（表头/行门控对称，双向锁死）
  assert.match(h.tips()[0], /<thead><tr><th>模型<\/th><th>Token 用量 ↓<\/th><th>请求次数<\/th><\/tr><\/thead>/);
  assert.match(h.tips()[2], /<thead><tr><th>模型<\/th><th>Token 用量 ↓<\/th><th>请求次数<\/th><\/tr><\/thead>/);
  assert.doesNotMatch(h.tips()[0], /<td>¥/);
  assert.doesNotMatch(h.tips()[2], /<td>¥/);
  // 会话累计模型明细表同走 statModelsTable 门控（曾为内联四列表漏门控，费用列常驻）
  assert.doesNotMatch(h.tips()[1], /预估费用/);
  assert.match(h.tips()[1], /<thead><tr><th>模型<\/th><th>Token 用量 ↓<\/th><th>请求次数<\/th><\/tr><\/thead>/);
  assert.doesNotMatch(h.tips()[1], /<td>¥/);
});

test('底部「价格来源…汇率…」脚注已从四格与紧凑摘要移除（信息收进气泡）', () => {
  const h = harness(); setup(h);
  h.window.__zusageUpdate(h.payload({}));
  for (const t of h.tips()) { if (!t) continue; assert.doesNotMatch(t, /tip-src|价格来源/); }
});

test('紧凑摘要（速率 chip tooltip）四行带费用尾注 + 来源行', () => {
  const h = harness(); setup(h);
  const payload = h.payload({});
  h.window.__zusageUpdate(payload);
  const build = h.window.__zuTpsTip;
  assert.ok(build, 'tpsChipTipHTML exposed after instance spawn');
  const row = payload.recent[0];
  const html = build({ v: { kind: 'db', sessAvg: 130.3, band: 'mid', dbTps: 102.2 },
    view: { session: row, last_turn: row.last_turn, today: payload.today,
      last: row.last, tools: { total: 1, errors: 0 }, sub: { total: 0, active: false } } });
  assert.match(html, /本轮<\/span><span class="tps-v">[^]*?· ¥3\.55/);
  assert.match(html, /会话累计<\/span><span class="tps-v">[^]*?· ¥7\.10/);
  assert.match(html, /项目累计<\/span><span class="tps-v">[^]*?· ¥21\.30/);
  assert.match(html, /今日合计<\/span><span class="tps-v">[^]*?· ¥14\.20/);
});

test('四格费用行带空心问号 icon；KPI 问号随卡携带模型上下文（v248）：单模型显该模型四价、多模型显计价范围，不借全局 last', () => {
  const h = harness(); setup(h);
  h.window.__zusageUpdate(h.payload({}));
  const costKpis = h.tips().filter(t2 => t2 && t2.indexOf('预估费用<svg class="tip-fxq"') >= 0);
  assert.equal(costKpis.length, 4, 'KPI list: ' + h.tips().map(x => String(x).slice(0, 40)).join(' ## '));   // 本轮/会话/今日/项目 KPI 费用格（子代理 scale 次级、速度独立 rt-row）
  for (const t2 of costKpis) assert.match(t2, /class="tip-fxq"/);
  const fx = h.fxTipEl();
  assert.ok(fx, 'fxTip mounted on body');
  assert.notEqual(fx.style.display, 'block');   // 初始未显示（cssText 继承路径下 display 可能未显式赋值）
  // 会话累计 KPI（夹具 2 模型）→ 计价范围行；绝不出现快照根部 last 的 GLM-5.3-FlashX
  //（回归：hy4 会话的气泡曾显示全局最近会话的 GLM-5.3-FlashX 牌价）
  h.hoverFxq(h, true, fxqAttrs(h.tips()[1]));
  assert.equal(fx.style.display, 'block');
  let html = fx.innerHTML;
  assert.match(html, /预估费用说明/);
  assert.match(html, /计价范围<\/b><span>本会话的全部 2 个模型，按各自模型价格分别计价/);
  assert.doesNotMatch(html, /当前模型|GLM-5\.3-FlashX/);
  // 今日合计 KPI（夹具单模型带四价）→ 该模型四价行（label 为「模型」，不再称「当前模型」）
  h.hoverFxq(h, true, fxqAttrs(h.tips()[2]));
  html = fx.innerHTML;
  assert.match(html, /模型<\/b><span><span class="zu-model-fit" style="display:inline-block;max-width:100%" title="GLM-5\.3-FlashX">GLM-5\.3-FlashX/);
  assert.match(html, /输入 ¥2\.12 · 输出 ¥7\.42 · 缓存读 ¥0\.60 · 缓存写 ¥0\.00（¥\/百万 token，按实时汇率折算）/);
  // 本轮 KPI（单模型）同上
  h.hoverFxq(h, true, fxqAttrs(h.tips()[0]));
  html = fx.innerHTML;
  assert.match(html, /模型<\/b><span><span class="zu-model-fit" style="display:inline-block;max-width:100%" title="GLM-5\.3-FlashX">GLM-5\.3-FlashX/);
  // 明细行 icon（data-model 无 data-mcount）仍为该行模型四价
  h.hoverFxq(h, true, { 'data-model': 'hy4', 'data-rates': '{"input":1,"output":2,"cache_read":0.5,"cache_write":0}' });
  html = fx.innerHTML;
  assert.match(html, /模型<\/b><span><span class="zu-model-fit" style="display:inline-block;max-width:100%" title="hy4">hy4/);
  assert.match(html, /输入 ¥7\.10 · 输出 ¥14\.20 · 缓存读 ¥3\.55 · 缓存写 ¥0\.00/);
  // 无上下文（旧快照/轻量行形态）：不显模型行，来源/公式/汇率行完整 —— 不再借 last 兜底
  h.hoverFxq(h, true, null);
  html = fx.innerHTML;
  assert.doesNotMatch(html, /当前模型|模型<\/b>/);
  assert.match(html, /价格来源<\/b><span><span class="fx-link"[^>]*data-url="https:\/\/models\.dev\/"[^>]*>models\.dev<\/span> 三方 AI 模型数据库/);
  assert.match(html, /计算公式<\/b><span>按每个模型的模型价格分开算/);
  assert.match(html, /汇率来源<\/b><span><span class="fx-link"[^>]*data-url="https:\/\/test"[^>]*>test<\/span> 实时汇率 · \$1 = ¥7\.1/);   // source 随快照 fx.source（夹具为 test）
  // 幂等：重复悬停不重建
  const sig = fx.__zuTipSig;
  h.hoverFxq(h, true, null);
  assert.equal(fx.__zuTipSig, sig);
  // mouseout → 180ms 后收起
  h.hoverFxq(h, false);
  assert.equal(fx.style.display, 'block');   // 宽限期仍在
});

test('无 fx 时气泡汇率来源行标「未获取到有效汇率」；USD 原价与宽限期收起不变', () => {
  const h = harness(); setup(h);
  h.window.__zusageUpdate(h.payload({ fx: null }));
  const rates = { input: 0.29879, output: 1.04577, cache_read: 0.08516, cache_write: 0 };
  h.hoverFxq(h, true, { 'data-model': 'GLM-5.3-FlashX', 'data-rates': JSON.stringify(rates) });
  const fx = h.fxTipEl();
  assert.match(fx.innerHTML, /暂无汇率，费用按 USD 原值显示/);
  assert.match(fx.innerHTML, /输入 \$0\.2988 · 输出 \$1\.0458 · 缓存读 \$0\.0852 · 缓存写 \$0（USD\/百万 token）/);
  h.hoverFxq(h, false);
  assert.equal(fx.style.display, 'block');   // 180ms 宽限期内仍显示，收起由 scheduleFxHide 定时器驱动
});

test('气泡内来源链接（下划线）点击走 openExternal 打开对应站点', () => {
  const h = harness(); setup(h);
  const opened = [];
  h.window.zcode = { openExternal: url => opened.push(url) };
  h.window.__zusageUpdate(h.payload({}));
  h.hoverFxq(h);
  const fx = h.fxTipEl();
  const stop = [];
  const link = { getAttribute: k => k === 'data-url' ? 'https://models.dev/' : null,
    closest: sel => sel === '.fx-link' ? link : null };
  fx.listeners.get('click')[0]({ target: link, stopPropagation: () => stop.push(1) });
  assert.deepEqual(opened, ['https://models.dev/']);
  assert.equal(stop.length, 1);
  // 汇率源链接随快照 source 换域名
  const fxLink = { getAttribute: k => k === 'data-url' ? 'https://test' : null,
    closest: sel => sel === '.fx-link' ? fxLink : null };
  fx.listeners.get('click')[0]({ target: fxLink, stopPropagation: () => stop.push(1) });
  assert.deepEqual(opened, ['https://models.dev/', 'https://test']);
});

test('速度 tooltip：宽度帽收窄标记（:has 640）+ 预估费用行与模型明细块', () => {
  const h = harness(); setup(h);
  const p = h.payload({});
  p.recent[0].last.tps = 102.2;        // 触发速度格 fallback 分支
  p.recent[0].avg_tps = 130.3;         // 会话平均态（口径行长文案）
  h.window.__zusageUpdate(p);
  const tips = h.tips();
  assert.match(tips[0], /zu-stat-tip--speed/);
  assert.match(tips[0], /zu-stat-scope">会话平均</);
  assert.match(tips[0], /zu-sl-val ok">130\.3<\/span><small class="zu-sl-unit">t\/s<\/small>/);   // v235 会话均读数档位色（结构化左卡）
  assert.match(tips[0], /zu-legend-item cur[^]*?70–150/);   // 当前档位描边（图例项=色点+范围数字）
  assert.doesNotMatch(tips[0], /rt-lsep/);   // 旧 · 分隔点已移除
  assert.match(tips[0], /\.zusage-tip-root:has\(\.zu-stat-tip--speed\)\{max-width:min\(860px/);   // v236 速度卡宽帽（v232 760→860；v236 860→1040：17 柱不横滚）
  assert.doesNotMatch(tips[0], /zu-speedcap/);   // 旧 640 隐藏标记已废除
  assert.doesNotMatch(tips[0], /预估费用/);   // v215.1 用户规格：速度卡不含费用行与模型明细
  assert.doesNotMatch(tips[0], /rt-models/);
});
