const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v385 OpenCode Go 模型口径换算（issue #382）：整 IIFE 执行 + Element 桩（overlay-quota-chip
 * 同款夹具）。非 live composer 走 p.last.model 兜底控制当前模型，byProvider 显式映射自定义
 * provider → 源 id（复合 opencode:<pid> 与裸 opencode 两形都有用例）；断言 chip 前插/换算
 * 门槛/模型口径分段/tooltip 金额与披露/锚定回落/钳顶/零重取与源数据零变异。 */
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
/* issue #382 报告者实测 meters（microcent→USD）：Go 档基线 12/30/60，账户已用
 * 0.2556/0.7902/4.3969。基线 percent 自算 2.13/2.63/7.33。 */
const OC_SOURCE = (windows, extra) => Object.assign({
  status: 'ok', label: 'OpenCode Go', kind: 'plan', providerId: 'opencode-go-chat', fetchedAt: NOW, stale: false, error: '',
  windows,
}, extra || {});
const OC_METERS = {
  fiveHour: { percent: 2.13, resetsAt: NOW + 3600e3, used: 0.25561772, total: 12, remaining: 11.74438228, currency: 'USD' },
  weekly: { percent: 2.63, resetsAt: NOW + 3 * 86400e3, used: 0.79024081, total: 30, remaining: 29.20975919, currency: 'USD' },
  monthly: { percent: 7.33, resetsAt: NOW + 25 * 86400e3, used: 4.39694317, total: 60, remaining: 55.60305683, currency: 'USD' },
};
const ocQuota = (windows, extra) => ({
  active: 'opencode:opencode-go-chat',
  byProvider: { 'opencode-go-chat': 'opencode:opencode-go-chat' },
  sources: { 'opencode:opencode-go-chat': OC_SOURCE(windows || OC_METERS, extra) },
});
const segsOf = chip => (chip.innerHTML.match(/(\d+)%<\/span>/g) || []).map(s => s.replace(/\D+/g, '')).join(',');

test('known model scales window totals from live ratios, keeps real used, recomputes percent (chip 1/2/4 not baseline 2/2/7)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'deepseek-v4.1-flash', quota: ocQuota() }));
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip, 'chip mounted for mapped custom opencode provider');
  /* deepseek-v4.1-flash 月度 $100：5h=100×12/60=20、周=50、月=100；
   * percent=used/新总额 → 1.28→1、1.58→2、4.40→4（基线应为 2/3/7）。 */
  assert.equal(segsOf(chip), '1,2,4');
  assert.match(chip.getAttribute('aria-label'), /套餐已用 5时 1%，7天 2%，月 4%/);
});

test('tooltip shows scaled amounts with real used and model-basis disclosure note', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'deepseek-v4.1-flash', quota: ocQuota() }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  const html = h.tipEl().innerHTML;
  assert.match(html, /\$0\.26 \/ \$20\.00/, '5小时 used 保留真实花费 $0.2556，总额换算 $20');
  assert.match(html, /\$0\.79 \/ \$50\.00/, '周窗总额 $50');
  assert.match(html, /\$4\.40 \/ \$100\.00/, '月窗总额 $100（官方模型口径）');
  assert.match(html, /剩余 \$19\.74/);
  assert.match(html, /窗口总额已按当前模型 <span class="qt-cur">deepseek-v4\.1-flash<\/span> 的月度额度换算/);
  assert.match(html, /opencode\.ai\/go 快照/);
  assert.ok(!/套餐池为账号级/.test(html), '模型口径下不再展示账号级固定页脚');
});

test('unknown model falls back to live baseline untouched (2/3/7, $12/$30/$60), no fabricated values', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'deepseek-v9-fake', quota: ocQuota() }));
  const chip = h.chipOf(ui.wrap);
  assert.equal(segsOf(chip), '2,3,7');
  chip.listeners.get('mouseenter')[0].call(chip);
  const html = h.tipEl().innerHTML;
  assert.match(html, /\$0\.26 \/ \$12\.00/);
  assert.match(html, /套餐池为账号级/, '未换算走账号级页脚');
  assert.ok(!/opencode\.ai\/go 快照/.test(html));
});

test('non-opencode source id never converts even when model matches the table', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: 'acme-chat', model: 'deepseek-v4.1-flash',
    quota: { active: 'acme:acme-chat', byProvider: { 'acme-chat': 'acme:acme-chat' },
      sources: { 'acme:acme-chat': OC_SOURCE(OC_METERS) } } }));
  assert.equal(segsOf(h.chipOf(ui.wrap)), '2,3,7', '源 id 非 opencode 前缀 → 原样基线');
});

test('tier anchor: baseline monthly ≠ Go $60 (Plus/changed baseline) stays untouched', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const plus = {
    fiveHour: { percent: 2.13, resetsAt: null, used: 0.25561772, total: 24, remaining: 0, currency: 'USD' },
    weekly: { percent: 2.63, resetsAt: null, used: 0.79024081, total: 60, remaining: 0, currency: 'USD' },
    monthly: { percent: 7.33, resetsAt: null, used: 4.39694317, total: 120, remaining: 0, currency: 'USD' },
  };
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'deepseek-v4.1-flash', quota: ocQuota(plus) }));
  assert.equal(segsOf(h.chipOf(ui.wrap)), '2,3,7', 'Plus 档基线未验证，不换算不伪造');
});

test('window ratios derive from live response, not hardcoded 20%/50%', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const shifted = {
    fiveHour: { percent: 16.67, resetsAt: null, used: 2.5, total: 15, remaining: 12.5, currency: 'USD' },
    weekly: { percent: 16.67, resetsAt: null, used: 5, total: 30, remaining: 25, currency: 'USD' },
    monthly: { percent: 16.67, resetsAt: null, used: 10, total: 60, remaining: 50, currency: 'USD' },
  };
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'deepseek-v4.1-flash', quota: ocQuota(shifted) }));
  /* 5h 占比 15/60=25% → deepseek 上限 25 → percent 2.5/25=10%（硬编码 20% 会得 12.5→13） */
  assert.equal(segsOf(h.chipOf(ui.wrap)), '10,10,10');
});

test('account spend above small-model cap clamps at 100% (exc band) with remaining $0.00', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const heavy = {
    fiveHour: { percent: 30, resetsAt: null, used: 3.6, total: 12, remaining: 8.4, currency: 'USD' },
    weekly: { percent: 30, resetsAt: null, used: 9, total: 30, remaining: 21, currency: 'USD' },
    monthly: { percent: 36.67, resetsAt: null, used: 22, total: 60, remaining: 38, currency: 'USD' },
  };
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'kimi-k3', quota: ocQuota(heavy) }));   // kimi-k3 月度 $15
  const chip = h.chipOf(ui.wrap);
  assert.equal(segsOf(chip), '100,100,100');
  assert.match(chip.innerHTML, /zu-qb-exc/, '≥100% 走满档异常态');
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.match(h.tipEl().innerHTML, /剩余 \$0\.00/);
});

test('model switch re-renders from the same unmutated source entry without refetch', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const quota = ocQuota();
  const srcBefore = JSON.stringify(quota.sources['opencode:opencode-go-chat']);   // 首次换算前采集：零变异断言直设防首帧污染
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'deepseek-v4.1-flash', quota }));
  assert.equal(segsOf(h.chipOf(ui.wrap)), '1,2,4', 'deepseek-v4.1-flash → 模型口径');
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'glm-5.2', quota }));   // glm-5.2 月度 $60 = 基线，换算为恒等
  assert.equal(segsOf(h.chipOf(ui.wrap)), '2,3,7');
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'gpt-6-luna', quota }));   // $15：5h=3 → 0.2556/3=8.52→9、周=7.5 → 0.7902/7.5=10.54→11、月=15 → 4.3969/15=29.31→29
  assert.equal(segsOf(h.chipOf(ui.wrap)), '9,11,29');
  assert.equal(JSON.stringify(quota.sources['opencode:opencode-go-chat']), srcBefore, '原始源数据零变异');
});

test('prototype-key model names never hit the table: constructor must not kill the chip or convert', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'constructor', quota: ocQuota() }));
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip, 'Object.prototype 键名不得让 chip 消失（hasOwnProperty 守卫）');
  assert.equal(segsOf(chip), '2,3,7', '未命中表 → 基线原样');
});

test('bare opencode source id (env/secrets key, non-composite) converts too', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'deepseek-v4.1-flash',
    quota: { active: 'opencode', byProvider: { 'opencode-go-chat': 'opencode' },
      sources: { opencode: OC_SOURCE(OC_METERS) } } }));
  assert.equal(segsOf(h.chipOf(ui.wrap)), '1,2,4', '裸 opencode 源 id 与复合源同门槛换算');
});

test('gate-fail passthrough never renders wire-provided modelBasis unescaped', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: 'opencode-go-chat', model: 'not-in-table',
    quota: ocQuota(OC_METERS, { modelBasis: '<i>x</i>' }) }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  const html = h.tipEl().innerHTML;
  assert.ok(!/<i>x<\/i>/.test(html), '透传的 modelBasis 必须经 esc 渲染');
  assert.match(html, /&lt;i&gt;x&lt;\/i&gt;/, '转义后可见（防直出）');
});
