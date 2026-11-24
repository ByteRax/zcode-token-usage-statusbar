const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* OpenCode Go 额度原样展示（v447，issue #453；撤回 v385 的按模型换算）：整 IIFE 执行 + Element 桩
 * （overlay-quota-chip 同款夹具）。官方口径是付费模型共用一个额度池，/console/api/go/status 的
 * meters（Go 档 12/30/60）即该池本身，各模型「月度额度」只是单模型整月的标价用量覆盖——
 * 渲染端不得按当前模型放大窗口总额或重算 percent。非 live composer 走 p.last.model 兜底控制
 * 当前模型，byProvider 显式映射自定义 provider → 源 id（复合 opencode:<pid> 与裸 opencode 两形
 * 都有用例）。断言按「用户看到的每个数」逐个锁定：chip 分段、tooltip 窗口行的已用比例/已用与
 * 总额/剩余三个数（只锁金额会漏掉「只在 tooltip 里改百分比」）、模型切换数字不变且源数据
 * 零变异、档位金额原样、账号级页脚、剩余口径、兜底链的纯百分比窗口、「其他源」行、快照
 * 透传的未知 modelBasis 不渲染。 */
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
   * 空表行为与旧桩一致（getItem 缺失返回 null）。
   * v440：默认种子 tipHoverMs=0（本夹具直呼 mouseenter 验开门后行为；门槛链由 overlay-tip-activation 锁） */
  const lsStore = new Map(Object.entries({ 'zusage3.tipHoverMs': '0', ...prefs }));
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

const NOW = Date.now();
const clone = (o) => JSON.parse(JSON.stringify(o));
/* issue #382 报告者实测 meters（microcent→USD）：Go 档 12/30/60，账户已用
 * 0.2556/0.7902/4.3969。percent=used/limit 即官方「额度已用比例」。
 * 每个源条目拿自己的一份窗口副本：实现若就地改写源对象，不会经共享夹具串到别的用例。 */
const OC_SOURCE = (windows, extra) => Object.assign({
  status: 'ok', label: 'OpenCode Go', kind: 'plan', providerId: 'opencode-go-chat', fetchedAt: NOW, stale: false, error: '',
  windows: clone(windows || {}),
}, extra || {});
const OC_METERS = {
  fiveHour: { percent: 2.13, resetsAt: NOW + 3600e3, used: 0.25561772, total: 12, remaining: 11.74438228, currency: 'USD' },
  weekly: { percent: 2.63, resetsAt: NOW + 3 * 86400e3, used: 0.79024081, total: 30, remaining: 29.20975919, currency: 'USD' },
  monthly: { percent: 7.33, resetsAt: NOW + 25 * 86400e3, used: 4.39694317, total: 60, remaining: 55.60305683, currency: 'USD' },
};
/* issue #453 报告者截图背后的源数据（当前模型 deepseek-v4.1-flash）：v385 曾把它显示成
 * $0.16/$20.00、$2.00/$50.00、$24.20/$100.00（chip 1/4/24），真实额度是 12/30/60（chip 1/7/40）。
 * resetsAt 为空，tooltip 行到「剩余」为止，便于整行逐字段断言。 */
const OC_453 = {
  fiveHour: { percent: 1.33, resetsAt: null, used: 0.16, total: 12, remaining: 11.84, currency: 'USD' },
  weekly: { percent: 6.67, resetsAt: null, used: 2, total: 30, remaining: 28, currency: 'USD' },
  monthly: { percent: 40.33, resetsAt: null, used: 24.2, total: 60, remaining: 35.8, currency: 'USD' },
};
/* Plus 档形状。percent 有意不等于 used/limit（实算 1.07/1.32/3.66），继承自 v385 的夹具：
 * 「原样展示」要求 percent 照接口值显示、不按金额重算，下面的 Plus 档用例借此锁定。 */
const OC_PLUS = {
  fiveHour: { percent: 2.13, resetsAt: null, used: 0.25561772, total: 24, remaining: 23.74438228, currency: 'USD' },
  weekly: { percent: 2.63, resetsAt: null, used: 0.79024081, total: 60, remaining: 59.20975919, currency: 'USD' },
  monthly: { percent: 7.33, resetsAt: null, used: 4.39694317, total: 120, remaining: 115.60305683, currency: 'USD' },
};
/* 兜底链（zen/go/v1/usage）的窗口形状：只有已用百分比，没有金额 */
const OC_PCT_ONLY = { fiveHour: { percent: 2.13 }, weekly: { percent: 2.63 }, monthly: { percent: 7.33 } };
const ocQuota = (windows, extra, sourceId = 'opencode:opencode-go-chat', extraSources) => ({
  active: sourceId,
  byProvider: { 'opencode-go-chat': sourceId },
  sources: Object.assign({ [sourceId]: OC_SOURCE(windows || OC_METERS, extra) }, extraSources || {}),
});
const segsOf = chip => (chip.innerHTML.match(/(\d+)%<\/span>/g) || []).map(s => s.replace(/\D+/g, '')).join(',');
/* 挂载 chip 并打开 tooltip（v440 悬停门槛由夹具种子 tipHoverMs=0 直通） */
function mount(h, opts, prefs) {
  const ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload(opts));
  const chip = h.chipOf(ui.wrap);
  return { ui, chip, tip: () => { chip.listeners.get('mouseenter')[0].call(chip); return h.tipEl().innerHTML; } };
}
const OC = { provider: 'opencode-go-chat', model: 'deepseek-v4.1-flash' };

test('issue #453: Go-tier meters render as-is for deepseek-v4.1-flash — chip 1/7/40, $12/$30/$60, never 20/50/100', () => {
  const h = harness(), m = mount(h, Object.assign({ quota: ocQuota(OC_453) }, OC));
  assert.ok(m.chip, 'chip mounted for mapped custom opencode provider');
  assert.equal(segsOf(m.chip), '1,7,40');
  assert.match(m.chip.getAttribute('aria-label'), /套餐已用 5时 1%，7天 7%，月 40%/);
  const html = m.tip();
  /* 整行逐字段：已用比例、已用/总额、剩余——三个数都必须是 meters 原值 */
  assert.match(html, /已用 1\.3% · \$0\.16 \/ \$12\.00 · 剩余 \$11\.84/);
  assert.match(html, /已用 6\.7% · \$2\.00 \/ \$30\.00 · 剩余 \$28\.00/);
  assert.match(html, /已用 40\.3% · \$24\.20 \/ \$60\.00 · 剩余 \$35\.80/);
  assert.doesNotMatch(html, /\$(20|50|100)\.00/, '不得出现按模型月度额度放大的 20/50/100');
});

test('official percent is kept: issue #382 meters show 2/3/7 and $12/$30/$60 for deepseek-v4.1-flash', () => {
  const h = harness(), m = mount(h, Object.assign({ quota: ocQuota() }, OC));
  assert.equal(segsOf(m.chip), '2,3,7', 'percent=used/limit 原值（v385 曾重算成 1/2/4）');
  const html = m.tip();
  assert.match(html, /已用 2\.1% · \$0\.26 \/ \$12\.00 · 剩余 \$11\.74/, '5 小时窗');
  assert.match(html, /已用 2\.6% · \$0\.79 \/ \$30\.00 · 剩余 \$29\.21/, '周窗');
  assert.match(html, /已用 7\.3% · \$4\.40 \/ \$60\.00 · 剩余 \$55\.60/, '月窗');
});

test('tooltip keeps the account-level footer and never shows a model-basis note', () => {
  const h = harness(), m = mount(h, Object.assign({ quota: ocQuota() }, OC));
  const html = m.tip();
  /* 当前模型确实到达 tooltip（前置条件成立，上面的「不换算」断言才不是空过） */
  assert.match(html, /套餐内全部模型（当前 <span class="qt-cur">deepseek-v4\.1-flash<\/span>）/);
  assert.match(html, /套餐池为账号级/);
  assert.doesNotMatch(html, /窗口总额已按当前模型|opencode\.ai\/go 快照/);
});

test('model switch leaves chip and tooltip numbers unchanged and never mutates the source entry', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const quota = ocQuota();
  const srcBefore = JSON.stringify(quota.sources['opencode:opencode-go-chat']);   // 首帧前采集：零变异断言直设防首帧污染
  for (const model of ['deepseek-v4.1-flash', 'kimi-k3', 'glm-5.2', 'deepseek-v9-fake']) {
    h.window.__zusageUpdate(h.payload({ provider: OC.provider, model, quota }));
    const chip = h.chipOf(ui.wrap);
    assert.ok(chip, 'chip stays mounted for ' + model);
    assert.equal(segsOf(chip), '2,3,7', model + '：分段恒为源数据 percent');
    chip.listeners.get('mouseenter')[0].call(chip);
    const html = h.tipEl().innerHTML;
    assert.match(html, /已用 7\.3% · \$4\.40 \/ \$60\.00/, model + '：月窗行');
    assert.ok(html.includes('（当前 <span class="qt-cur">' + model + '</span>）'), 'tooltip 跟随当前模型 ' + model);
  }
  assert.equal(JSON.stringify(quota.sources['opencode:opencode-go-chat']), srcBefore, '原始源数据零变异');
});

test('other tiers render their own meters as-is — percent shown as given, not recomputed from amounts (Plus-like 24/60/120)', () => {
  const h = harness(), m = mount(h, Object.assign({ quota: ocQuota(OC_PLUS) }, OC));
  assert.equal(segsOf(m.chip), '2,3,7', 'percent 照接口值；按 used/total 重算会得到 1/1/4');
  const html = m.tip();
  assert.match(html, /已用 2\.1% · \$0\.26 \/ \$24\.00 · 剩余 \$23\.74/);
  assert.match(html, /已用 7\.3% · \$4\.40 \/ \$120\.00 · 剩余 \$115\.60/);
});

test('bare opencode source id (env/secrets key, non-composite) renders as-is on chip and tooltip', () => {
  const h = harness(), m = mount(h, Object.assign({ quota: ocQuota(OC_METERS, undefined, 'opencode') }, OC));
  assert.equal(segsOf(m.chip), '2,3,7', '裸 opencode 源 id 与复合源同口径（v385 曾换算成 1/2/4）');
  assert.match(m.tip(), /已用 7\.3% · \$4\.40 \/ \$60\.00/);
});

test('non-opencode source with the same windows is unaffected', () => {
  const h = harness(), m = mount(h, { provider: 'acme-chat', model: OC.model,
    quota: { active: 'acme:acme-chat', byProvider: { 'acme-chat': 'acme:acme-chat' },
      sources: { 'acme:acme-chat': OC_SOURCE(OC_METERS) } } });
  assert.equal(segsOf(m.chip), '2,3,7');
});

test('remaining view (v251) is derived from the official percent, on chip and tooltip', () => {
  const h = harness({ prefs: { 'zusage3.quotaRemain': '1' } });
  const m = mount(h, Object.assign({ quota: ocQuota(OC_453) }, OC));
  assert.equal(segsOf(m.chip), '99,93,60', '剩余%=100−官方已用%（1.33/6.67/40.33 的补数；v385 曾得 99/96/76）');
  assert.match(m.chip.getAttribute('aria-label'), /套餐剩余 5时 99%，7天 93%，月 60%/);
  const html = m.tip();   // 剩余口径下窗口行：剩余% 打头，已用退为行末明细
  assert.match(html, /剩余 98\.7% · \$11\.84 \/ \$12\.00 · 已用 \$0\.16/);
  assert.match(html, /剩余 59\.7% · \$35\.80 \/ \$60\.00 · 已用 \$24\.20/);
});

test('percent-only windows (public usage fallback chain, no amounts) render as-is', () => {
  const h = harness(), m = mount(h, Object.assign({ quota: ocQuota(OC_PCT_ONLY) }, OC));
  assert.equal(segsOf(m.chip), '2,3,7');
  const html = m.tip();
  assert.match(html, /已用 2\.1%<\/span>/);
  assert.match(html, /已用 7\.3%<\/span>/);
  assert.doesNotMatch(html, /\$\d/, '纯百分比窗口不得凭空出现金额');
});

test('tooltip "other sources" row lists a non-primary opencode source with its own percents', () => {
  const h = harness(), m = mount(h, { provider: 'acme-chat', model: OC.model,
    quota: { active: 'acme:acme-chat', byProvider: { 'acme-chat': 'acme:acme-chat' },
      sources: { 'acme:acme-chat': OC_SOURCE(OC_METERS), 'opencode:opencode-go-chat': OC_SOURCE(OC_METERS) } } });
  /* 夹具没有 srcLabels，标签回退为源 id */
  assert.match(m.tip(), /其他源<\/b><span>opencode:opencode-go-chat 2% 3% 7%<\/span>/);
});

test('wire-provided modelBasis is not a protocol field: never rendered raw nor as a note', () => {
  const h = harness(), m = mount(h, Object.assign({ quota: ocQuota(OC_METERS, { modelBasis: '<i>x</i>' }) }, OC));
  const html = m.tip();
  assert.ok(!/<i>x<\/i>/.test(html), '快照透传的未知字段不得直出');
  assert.ok(!/&lt;i&gt;x&lt;\/i&gt;/.test(html), '也不作为披露文本渲染');
  assert.doesNotMatch(html, /窗口总额已按当前模型/);
  assert.match(html, /套餐池为账号级/);
  assert.equal(segsOf(m.chip), '2,3,7');
  assert.match(html, /已用 7\.3% · \$4\.40 \/ \$60\.00/);
});
