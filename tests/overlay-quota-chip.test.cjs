const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v96 套餐额度 chip：整 IIFE 执行 + instances 接缝（overlay-ctxbtn 同款夹具）。
 * 夹具：输入卡片 group/toolbar 工具行放 wrapper span > button[data-testid=chat-context-usage-trigger]，
 * 推带 quota 字段与 recent[].last.provider_id 的 payload，断言 chip 前插/门控/档位/幂等/兜回/还原/tooltip。 */
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

function harness({ quotaOn = true } = {}) {
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
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' }, localStorage: { getItem: () => null, setItem() {} },
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
  return { window, body, inject, tick, boot, buildComposer, payload, chipOf, liveOf, tipEl, mutate, observers };
}

const NOW = Date.now();
const QUOTA_OK = {
  status: 'ok', providerId: 'account:bigmodel-individual-coding-plan', fetchedAt: NOW, stale: false, error: '', level: 'max',
  windows: { fiveHour: { percent: 26, resetsAt: NOW + 3600e3, details: [] }, weekly: { percent: 12, resetsAt: NOW + 3 * 86400e3, details: [] } },
  tools: { used: 48, total: 4000, resetsAt: NOW + 7 * 86400e3 }, models: ['GLM-5.3-Flash', 'GLM-4.6'],
  plan: { version: 'V1', productName: 'GLM Coding Max', validStart: '2026-02-28', validEnd: '2027-02-28' },
};
const withPct = (p, extra) => Object.assign({}, QUOTA_OK, { windows: { fiveHour: { percent: p, resetsAt: null, details: [] }, weekly: null } }, extra || {});

test('chip is inserted directly left of the context button with per-window segments and band colors', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip, 'chip mounted');
  assert.equal(ui.wrap.children.indexOf(chip), ui.wrap.children.indexOf(ui.btn) - 1);
  assert.equal(chip.className, 'zu-quota');
  assert.equal(chip.innerHTML,
    '<span class="zu-qseg zu-qb-calm"><span class="zu-qlabel">5小时</span> 26%</span><span class="zu-qsep">|</span><span class="zu-qseg zu-qb-calm"><span class="zu-qlabel">7天</span> 12%</span>');
  assert.equal(chip.getAttribute('aria-label'), '套餐已用 5小时 26%，7天 12%');
  const live = h.liveOf(h.body.children.find(e => e.className === 'zusage-root'));
  assert.ok(live, 'a visually hidden live region is mounted inside this pane bar');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.getAttribute('role'), 'status');
  assert.equal(live.getAttribute('aria-atomic'), 'true');
  assert.equal(live.parentElement.className, 'zusage-root', 'live region is scoped to its owning pane');
  assert.equal(chip.parentElement, ui.wrap, 'button chip stays beside the native context control');
  assert.equal(live.textContent, '套餐已用 5小时 26%，7天 12%');
  assert.equal(chip.getAttribute('role'), 'button');
  assert.ok(chip.listeners.get('click') && chip.listeners.get('mouseenter'));
});

test('display gates: toggle off, unknown provider (new session), custom provider, old main process without quota field', () => {
  const off = harness({ quotaOn: false }), u0 = off.buildComposer('workspace-main', 'sid_main');
  off.inject(); off.boot(); off.tick();
  off.window.__zusageUpdate(off.payload({ quota: QUOTA_OK }));
  assert.equal(off.chipOf(u0.wrap), undefined, 'main-process truth off (explicit false) hides chip');

  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: '', quota: QUOTA_OK }));   // 会话首个 main_turn 未完成
  assert.equal(h.chipOf(ui.wrap), undefined, 'no provider yet → hidden');
  h.window.__zusageUpdate(h.payload({ provider: 'new-provider', quota: QUOTA_OK }));   // 自定义 provider：不属套餐池
  assert.equal(h.chipOf(ui.wrap), undefined, 'custom provider → hidden');
  h.window.__zusageUpdate(h.payload());   // 旧主进程：payload 无 quota 字段
  assert.equal(h.chipOf(ui.wrap), undefined, 'no quota field → hidden, no throw');
  h.window.__zusageUpdate(h.payload({ quota: { status: 'not_configured', fetchedAt: 0, stale: false, error: '' } }));
  const ncChip = h.chipOf(ui.wrap);
  assert.ok(ncChip, 'not_configured → neutral info chip (v111 no longer hidden)');
  assert.match(ncChip.innerHTML, /额度 未配置/);
  assert.equal(ncChip.getAttribute('aria-label'), '额度 未配置');
  ncChip.listeners.get('mouseenter')[0].call(ncChip);   // info 分支 tooltip 引导去 ⚙ 配置
  assert.match(h.tipEl().innerHTML, /额度源/);
  h.window.__zusageUpdate(h.payload({ quota: { status: 'unsupported', reason: 'provider', fetchedAt: 0, stale: false, error: '' } }));
  const usChip = h.chipOf(ui.wrap);
  assert.ok(usChip, 'unsupported → neutral info chip (v111 no longer hidden)');
  assert.match(usChip.innerHTML, /额度 暂不支持/);
  h.window.__zusageUpdate(h.payload({ quota: { status: 'disabled', fetchedAt: 0, stale: false, error: '' } }));
  assert.equal(h.chipOf(ui.wrap), undefined, 'disabled (source explicitly off in ⚙) → hidden');
});

test('v111 default-on: chip shows when the initial plugin state lacks quotaEnabled', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.window.__zusagePluginState = {};   // 初始无该字段（主进程首推未到/字段缺省）：缺省开方向
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  assert.ok(h.chipOf(ui.wrap), 'quota data arrives → chip shown without explicit quotaEnabled:true');
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qpct|zu-qseg/);   // 显示的是数据段，不是占位
});

test('team plan shows an explicit unsupported glyph instead of numbers', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: 'account:bigmodel-team-coding-plan', quota: { status: 'unsupported', reason: 'team', fetchedAt: 0, stale: false, error: '' } }));
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip);
  assert.match(chip.innerHTML, /⊘/);
  assert.doesNotMatch(chip.innerHTML, /zu-qpct/);
  assert.equal(chip.getAttribute('aria-label'), '团队套餐额度暂不支持');
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.match(h.tipEl().innerHTML, /团队套餐/);
});

test('segments use user bands 30/50/80/90 (inclusive lower bound); mixed windows keep their own bands', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: withPct(29.6) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg zu-qb-calm"><span class="zu-qlabel">5小时<\/span> 30%<\/span>/);   // 档位按原始值判（29.6 < 30 为 calm），显示四舍五入
  h.window.__zusageUpdate(h.payload({ quota: withPct(30) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg zu-qb-norm"><span class="zu-qlabel">5小时<\/span> 30%<\/span>/);
  h.window.__zusageUpdate(h.payload({ quota: withPct(50) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg zu-qb-mid"><span class="zu-qlabel">5小时<\/span> 50%<\/span>/);
  h.window.__zusageUpdate(h.payload({ quota: withPct(80) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg zu-qb-high"><span class="zu-qlabel">5小时<\/span> 80%<\/span>/);
  h.window.__zusageUpdate(h.payload({ quota: withPct(90) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg zu-qb-crit"><span class="zu-qlabel">5小时<\/span> 90%<\/span>/);
  h.window.__zusageUpdate(h.payload({ quota: withPct(100) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg zu-qb-exc"><span class="zu-qlabel">5小时<\/span> 100%<\/span>/);   // ≥100 满档呼吸闪烁（用户规格保留）
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { windows: { fiveHour: { percent: 96, resetsAt: null, details: [] }, weekly: { percent: 10, resetsAt: null, details: [] } } }) }));
  assert.equal(h.chipOf(ui.wrap).innerHTML,
    '<span class="zu-qseg zu-qb-crit"><span class="zu-qlabel">5小时</span> 96%</span><span class="zu-qsep">|</span><span class="zu-qseg zu-qb-calm"><span class="zu-qlabel">7天</span> 10%</span>');
  assert.equal(h.liveOf(h.body.children.find(e => e.className === 'zusage-root')).textContent, '套餐已用 5小时 96%，7天 10%', 'live region announces changed values');
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { windows: { fiveHour: { percent: 96, resetsAt: null, details: [] }, weekly: { percent: 10, resetsAt: null, details: [] } } }) }));
  assert.equal(h.liveOf(h.body.children.find(e => e.className === 'zusage-root')).textContent, '套餐已用 5小时 96%，7天 10%', 'unchanged values do not rewrite the live region');
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { busy: true, windows: { fiveHour: { percent: 96, resetsAt: null, details: [] }, weekly: { percent: 10, resetsAt: null, details: [] } } }) }));
  assert.equal(h.liveOf(h.body.children.find(e => e.className === 'zusage-root')).textContent, '套餐额度查询中', 'busy state is announced');
  h.window.quotaTest.instances()[0].dispose();
  assert.equal(h.liveOf(ui.card.parentElement), undefined, 'pane disposal removes its live region with the bar');
});

test('failures keep the last good value with a warning mark; no value shows the mark alone; stale dims', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { status: 'network_error', error: 'HTTP 502' }) }));
  let chip = h.chipOf(ui.wrap);
  assert.match(chip.innerHTML, /7天<\/span> 12%<\/span><span class="zu-qwarn">⚠<\/span>/);   // 旧值保留 + 警示标
  h.window.__zusageUpdate(h.payload({ quota: { status: 'auth_failed', fetchedAt: 0, stale: false, error: 'HTTP 401' } }));
  chip = h.chipOf(ui.wrap);
  assert.equal(chip.innerHTML, '<span class="zu-qwarn">⚠</span>');
  assert.equal(chip.getAttribute('aria-label'), '认证失效：重新登录 ZCode 后自动恢复');
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { stale: true }) }));
  chip = h.chipOf(ui.wrap);
  assert.equal(chip.className, 'zu-quota zu-qstale');
  // ok 态但接口回空窗口：没有可显示的数字 → 不渲染空 chip
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { windows: { fiveHour: null, weekly: null } }) }));
  assert.ok(!h.chipOf(ui.wrap));
});

test('react commit that displaces the chip is healed back to the button\'s left within one heavy tick', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  const chip = h.chipOf(ui.wrap);
  ui.wrap.children.splice(ui.wrap.children.indexOf(chip), 1);   // 模拟 React 提交把手动节点挤到按钮之后
  ui.wrap.children.push(chip);
  assert.equal(ui.wrap.children[ui.wrap.children.length - 1], chip);
  h.tick();
  assert.equal(ui.wrap.children.indexOf(chip), ui.wrap.children.indexOf(ui.btn) - 1);
  assert.equal(ui.wrap.children.filter(e => e.classList.contains('zu-quota')).length, 1);
});

test('reapply is idempotent: same node, single chip, innerHTML untouched when nothing changed', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  const first = h.chipOf(ui.wrap);
  first.innerHTML = first.innerHTML + '<!--hover-state-->';   // 若重建会抹掉这段标记
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  h.tick(); h.tick();
  const again = h.chipOf(ui.wrap);
  assert.equal(again, first);
  assert.match(again.innerHTML, /hover-state/);
  assert.equal(ui.wrap.children.filter(e => e.classList.contains('zu-quota')).length, 1);
});

test('click requests a manual refresh through the plugin request queue', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  const chip = h.chipOf(ui.wrap);
  let prevented = 0;
  chip.listeners.get('click')[0].call(chip, { preventDefault: () => { prevented++; }, stopPropagation: () => { prevented++; } });
  assert.equal(prevented, 2);
  assert.deepEqual(h.window.__zusagePluginRequests.filter(r => r.action === 'quota-refresh').length, 1);
  assert.equal(chip.classList.contains('zu-qbusy'), false, 'sending a request is not evidence of query start');
});

test('hover tooltip lists windows, built-in tools, highlights the current model and shows status/update time', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { status: 'rate_limited', error: 'HTTP 429' }) }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl();
  assert.equal(tip.style.display, 'block');
  const html = tip.innerHTML;
  assert.match(html, /套餐额度 · GLM Coding Max · V1 · 有效期至 2027-02-28/);   // 订阅元数据拼进标题（有 plan 时替代 family+档位）
  assert.doesNotMatch(html, /BigModel Max/);
  assert.doesNotMatch(html, /套餐<\/b>/);   // 独立套餐行已去掉
  assert.match(html, /5小时窗口<\/b><span>已用 26%/);
  assert.match(html, /本周窗口<\/b><span>已用 12%/);
  assert.match(html, /内置工具<\/b><span>48 \/ 4000 次/);
  assert.match(html, /<span class="qt-cur">GLM-5\.3-Flash<\/span>, GLM-4\.6/);
  assert.match(html, /更新于 \d{4}-\d\d-\d\d \d\d:\d\d/);   // 统一 yyyy-MM-dd HH:mm
  assert.match(html, /重置 \d{4}-\d\d-\d\d \d\d:\d\d/);
  assert.match(html, /⚠ 接口限流/);
  assert.match(html, /账号级：同账号所有模型共用，不是单个模型独享/);   // 共享范围说明：只以否定句出现，不把池标成某模型独享
  assert.doesNotMatch(html, /模型额度|独享额度/);
  chip.listeners.get('mouseleave')[0].call(chip);
  assert.equal(tip.style.display, 'none');
});

test('tooltip survives scroll bursts: chip is fixed in the composer toolbar, streaming auto-scroll must not dismiss it (v106)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl();
  assert.equal(tip.style.display, 'block');
  const scrollers = h.window.listeners.get('scroll') || [];
  assert.ok(scrollers.length >= 1, 'a scroll listener is registered on window');   // 夹具不记录 capture 标志；生产代码 window 级 scroll 仅此一处注册
  for (let i = 0; i < 5; i++) scrollers.forEach(fn => fn.call(h.window, { type: 'scroll' }));   // 思考中流式输出：聊天容器连续自动滚动
  assert.equal(tip.style.display, 'block', 'quota tooltip stays open across scroll bursts');
  chip.listeners.get('mouseleave')[0].call(chip);
  assert.equal(tip.style.display, 'none', 'mouseleave still dismisses it');
  /* 速率行浮层的宿主在消息流内，滚动即收的既有契约保持；只有额度 chip 被豁免 */
  assert.match(source, /function hideTipsOnScroll\(\) \{ hideRateTip\(\); \}/);
});

test('tooltip is swept by the 500ms scan when its chip is detached (React rebuild sends no mouseleave), not left dangling (v106)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl();
  assert.equal(tip.style.display, 'block');
  chip.remove();   // 模拟宿主重建：旧 chip 随旧 wrap 丢弃
  (h.window.listeners.get('scroll') || []).forEach(fn => fn.call(h.window, { type: 'scroll' }));
  assert.equal(tip.style.display, 'block', 'scroll alone still never dismisses the quota tooltip (exemption holds after detach)');
  h.tick();        // 下一个 500ms 扫描 tick（enhance 重建新 chip 后 tooltip 也不再指向旧宿主）
  assert.equal(tip.style.display, 'none', 'dangling tooltip swept once host chip is detached');
});

test('tooltip without usage details falls back to "all models in the plan" with the current model named', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { models: [] }) }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.match(h.tipEl().innerHTML, /套餐内全部模型（当前 <span class="qt-cur">GLM-5\.3-Flash<\/span>）/);
});

test('turning the toggle off and disposing both remove the chip without orphans', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  assert.ok(h.chipOf(ui.wrap));
  const chip = h.chipOf(ui.wrap), tip = h.tipEl();
  chip.listeners.get('mouseenter')[0].call(chip);   // 悬停中关开关：chip 与 tooltip 一起收
  assert.equal(tip.style.display, 'block');
  h.window.__zusagePluginUpdate({ quotaEnabled: false });   // 主进程回推：config quota_enabled 已关
  h.tick();
  assert.equal(h.chipOf(ui.wrap), undefined, 'main-process truth off → chip removed at heavy tick');
  assert.equal(tip.style.display, 'none', 'tooltip dismissed with the chip');
  h.window.__zusagePluginUpdate({ quotaEnabled: true });
  h.tick();
  assert.ok(h.chipOf(ui.wrap), 'truth on again → chip back (lastQuota retained)');
  h.window.quotaTest.instances()[0].dispose();
  assert.ok(!h.chipOf(ui.wrap));
  assert.equal(ui.wrap.children.length, 1);
  assert.equal(ui.wrap.children[0], ui.btn);
});

test('settings checkbox is config-backed: change emits a "quota" plugin request and updates optimistically', () => {
  const h = harness({ quotaOn: false }), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  assert.ok(!h.chipOf(ui.wrap));
  const inst = h.window.quotaTest.instances()[0];
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  assert.ok(panel, 'settings panel mounted on body');
  const box = new Element('input');
  box.classList.add('zu-quota-enable'); box.checked = true; box.type = 'checkbox';
  panel.listeners.get('change')[0]({ target: box });
  const reqs = h.window.__zusagePluginRequests.filter(r => r.action === 'quota');
  assert.equal(reqs.length, 1);   // 跨 vm context 的对象不做 deepEqual（原型不同），按字段断言
  assert.equal(reqs[0].action, 'quota');
  assert.equal(reqs[0].enabled, true);
  assert.match(reqs[0].requestId, /^zusage-\d+-\d+$/);
  h.tick();
  assert.ok(h.chipOf(ui.wrap), 'optimistic update shows the chip before the main process confirms');
  void inst;
});

test('settings panel exposes the config-backed quota toggle (default on, v111) with the credential disclosure', () => {
  assert.match(source, /quotaEnabled: !\(window\.__zusagePluginState && window\.__zusagePluginState\.quotaEnabled === false\)/);   // 缺省开，仅显式 false 关
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'inject-main.cjs'), 'utf8');
  assert.match(mainSrc, /quota_enabled !== false/);   // 主进程真值同向（v111）：缺省开，显式 false 才关
  assert.doesNotMatch(source, /show: \{[^}]*quota/);   // 不是 localStorage 显示项：真值只在 config.json
  assert.match(source, /<input type="checkbox" class="zu-quota-enable">/);
  assert.match(source, /pluginRequest\("quota", requestedQuota, function \(result\)/);
  assert.match(source, /pluginRequest\("quota", requestedQuota, function \(result\)[\s\S]*?state\.quotaEnabled = previousQuota/);
  assert.match(source, /凭据仅在内存使用、不落盘、不进日志与诊断：内置套餐发往 bigmodel\.cn \/ api\.z\.ai 官方域/);   // 阶段 3 分域披露
  assert.match(source, /zu-src-list/);   // ⚙ 源列表容器
  assert.match(source, /pluginRequest\("quota-src-key", \{ id: field\.dataset\.src, field: field\.dataset\.field, value: field\.value \}, function \(result\)/);
  assert.match(source, /\.zu-quota\{display:inline-flex;align-items:center;gap:5px;height:1\.75rem/);
  assert.match(source, /\.zu-quota\{display:inline-flex;align-items:center;gap:5px;height:1\.75rem;padding:0 6px;border-radius:\.5rem;cursor:pointer;user-select:none;flex:0 0 auto;/);   // 布局盒
  assert.match(source.slice(source.indexOf('\".zu-quota{'), source.indexOf('\".zu-quota{') + 600), /font-size:calc\(var\(--text-ui-base,var\(--ui-font-size,14px\)\) - 1px\);font-weight:700;font-variant-numeric:tabular-nums\}/);
  assert.match(source, /\.zu-qsep\{color:var\(--color-foreground-subtle/);
  assert.match(source, /\.zu-qseg\{white-space:nowrap\}/);   // 基色废止：色全由档位类提供
  // 三档视觉映射五档阈值（2026-10-28 用户规格）：calm+norm(<50) 绿 / mid+high(50–89) 黄 / crit(≥90) 红
  assert.match(source, /\.zu-qseg\.zu-qb-calm,\.zu-qseg\.zu-qb-norm\{color:#3ecf8e\}/);
  assert.match(source, /\.zu-qseg\.zu-qb-mid,\.zu-qseg\.zu-qb-high\{color:#f5b944\}/);
  assert.match(source, /\.zu-qseg\.zu-qb-crit\{color:#ff6b57\}/);
  assert.doesNotMatch(source, /s\.wkey/);   // zu-qweekly 按周期着色残留已清
  assert.doesNotMatch(source, /\.zu-qseg\.zu-qweekly\{color:/);   // v131 按窗口类型着色废止（仅按百分比）
  assert.match(source, /\.zu-qseg\.zu-qb-exc\{color:var\(--color-destructive,#ff2d55\);text-shadow:0 0 8px rgba\(255,45,85,\.5\);animation:zuexc/);   // ≥100 满档呼吸闪烁（用户规格）
  assert.match(source, /\.zu-quota\[data-zusage-light\] \.zu-qseg\.zu-qb-exc\{text-shadow:none\}/);
  assert.doesNotMatch(source, /\.zu-qseg \.zu-qlabel\{font-weight/);   // 标签随容器 700（偏细 → 用户规格 2026-10-28）
  assert.match(source, /\.zu-quota\[data-zusage-light\] \.zu-qseg\.zu-qb-calm,\.zu-quota\[data-zusage-light\] \.zu-qseg\.zu-qb-norm\{color:#0f9d6c\}/);
  assert.match(source, /\.zu-quota\[data-zusage-light\] \.zu-qseg\.zu-qb-mid,\.zu-quota\[data-zusage-light\] \.zu-qseg\.zu-qb-high\{color:#b6791a\}/);
  assert.match(source, /\.zu-quota\[data-zusage-light\] \.zu-qseg\.zu-qb-crit\{color:#d8482f\}/);
  assert.match(source, /data-zusage-armed\]\{color:#3ecf8e!important/);   // 上下文 calm 基色=三档绿（限按钮作用域）
  assert.match(source, /\[data-zusage-light\]\[data-zusage-armed\]\[data-zusage-band=calm\],\[data-zusage-light\]\[data-zusage-armed\]\[data-zusage-band=norm\]\{color:#0f9d6c!important\}/);   // 浅色档带 armed 补特异性
  assert.doesNotMatch(source, /\[data-zusage-armed\] \.zu-ctxpct\.ok\{color:#72c9a2\}/);   // v131 pct 与环一律继承按钮 currentColor
  assert.doesNotMatch(source, /zu-qring/);   // v96 起环形已删（分段样式）
  assert.match(source, /\.zusage-quota-tip,\.zu-quota,/);   // 代际清理选择器含 chip 与其 tooltip
});

test('balance-type quota renders a single amount segment (stage-3 adapter contract)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { balance: { amount: 100, currency: 'CNY' } }) }));
  const chip = h.chipOf(ui.wrap);
  assert.equal(chip.innerHTML, '<span class="zu-qseg zu-qb-calm">余额 ¥100.00</span>');
  assert.equal(chip.getAttribute('aria-label'), '余额 ¥100.00');
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { balance: { amount: 12.5, currency: 'USD' } }) }));
  assert.equal(h.chipOf(ui.wrap).innerHTML, '<span class="zu-qseg zu-qb-calm">余额 $12.50</span>');
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { balance: { amount: 3, currency: 'EUR' } }) }));
  assert.equal(h.chipOf(ui.wrap).innerHTML, '<span class="zu-qseg zu-qb-calm">余额 EUR 3.00</span>');
});

test('tooltip omits the subscription row when plan metadata is missing (endpoint failure degrade)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { plan: null }) }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  const html = h.tipEl().innerHTML;
  assert.doesNotMatch(html, /有效期至/);
  assert.doesNotMatch(html, /GLM Coding Max/);
  assert.match(html, /5小时窗口/);   // 额度行不受订阅缺失影响
  assert.match(html, /套餐额度 · BigModel Max/);   // plan 缺失回退 family+档位标题
});

test('session without any request history falls back to the account-level provider_fallback', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  // 新会话/刚切模型：本会话无完成请求（provider 空），快照顶层带账号级回退
  const out = { remote_evidence: false, today: {}, not_local: [],
    recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0, last: {} }],
    provider_fallback: 'account:bigmodel-individual-coding-plan', quota: QUOTA_OK };
  h.window.__zusageUpdate(out);
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip, 'fallback shows the chip before the first request lands');
  assert.match(chip.innerHTML, /5小时<\/span> 26%/);
  // 回退指向自定义 provider（理论态）：不显示
  const out2 = Object.assign({}, out, { provider_fallback: 'new-provider-4' });
  h.window.__zusageUpdate(out2);
  assert.ok(!h.chipOf(ui.wrap));
  // 无回退字段（旧主进程）：维持隐藏
  h.window.__zusageUpdate(h.payload({ provider: '' }));
  assert.ok(!h.chipOf(ui.wrap));
  // 会话自己的最新请求是自定义 provider：优先于回退，隐藏
  h.window.__zusageUpdate(h.payload({ provider: 'new-provider-4', quota: QUOTA_OK }));
  assert.equal(h.chipOf(ui.wrap), undefined, 'session-level custom provider wins over fallback');
});

test('stage-3 protocol {active, sources}: chip reads the active source entry; flat fallback kept', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const entry = Object.assign({}, QUOTA_OK, { status: 'ok' });
  h.window.__zusageUpdate({ remote_evidence: false, today: {}, not_local: [],
    quota: { active: 'bigmodel', sources: { bigmodel: entry, deepseek: { status: 'ok', fetchedAt: NOW, stale: false, error: '', balance: { amount: 110, currency: 'CNY' } } } },
    recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
      last: { provider_id: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-Flash' } }] });
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip, 'new-shape payload mounts chip from sources[active]');
  assert.match(chip.innerHTML, /5小时<\/span> 26%/);
  // 平铺旧形状仍兼容
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /5小时<\/span> 26%/);
});

test('tooltip shows monthly window, balance parts split and other-source summaries', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusagePluginUpdate({ quotaEnabled: true, quotaSources: [
    { id: 'bigmodel', label: 'BigModel', enabled: true },
    { id: 'deepseek', label: 'DeepSeek', enabled: true },
    { id: 'scnet', label: 'SCNet', enabled: true },
  ] });
  h.window.__zusageUpdate({ remote_evidence: false, today: {}, not_local: [],
    quota: {
      active: 'bigmodel',
      sources: {
        bigmodel: Object.assign({}, QUOTA_OK, { windows: { fiveHour: { percent: 26, resetsAt: null }, weekly: { percent: 12, resetsAt: null }, monthly: { percent: 5, resetsAt: NOW + 86400e3 } }, balance: { amount: 110, currency: 'CNY', parts: [{ label: '赠送', amount: 10 }, { label: '充值', amount: 100 }] } }),
        deepseek: { status: 'ok', fetchedAt: NOW, stale: false, error: '', balance: { amount: 110, currency: 'CNY' } },
        scnet: { status: 'ok', fetchedAt: NOW, stale: false, error: '', windows: { monthly: { percent: 44, resetsAt: null } } },
      },
    },
    recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
      last: { provider_id: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-Flash' } }] });
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  const html = h.tipEl().innerHTML;
  assert.match(html, /月度窗口<\/b><span>已用 5%/);
  assert.match(html, /余额<\/b><span>¥110\.00（赠送 10 \/ 充值 100）/);
  assert.match(html, /其他源<\/b><span>DeepSeek ¥110\.00 · SCNet 44%/);
});

test('settings source list renders rows and emits quota-src / quota-src-key / quota-src-refresh requests', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  h.window.__zusagePluginUpdate({ quotaEnabled: true, quotaSources: [
    { id: 'minimax', label: 'MiniMax', kind: 'plan', enabled: true, unverified: true, credentialFields: ['apiKey'], keyConfigured: true, status: 'ok' },
    { id: 'mimo', label: '小米 MiMo', kind: 'plan', enabled: false, unverified: true, credentialFields: ['cookie'], keyConfigured: false, status: 'not_configured' },
  ] });
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  const list = panel.queries.get('.zu-src-list') || new Element();
  // 面板构建走 buildPanel 字符串；syncQuotaSources 直接写 .zu-src-list innerHTML——用面板查询接缝拿不到
  // 实例闭包里的真实 DOM，改从源码契约断言 + change/click 委托行为：
  const enable = new Element('input');
  enable.classList.add('zu-src-enable'); enable.dataset.src = 'mimo'; enable.checked = true; enable.type = 'checkbox';
  panel.listeners.get('change')[0]({ target: enable });
  const field = new Element('input');
  field.classList.add('zu-src-field'); field.dataset.src = 'mimo'; field.dataset.field = 'cookie'; field.value = 'userId=1; serviceToken=abc';
  panel.listeners.get('change')[0]({ target: field });
  const btn = new Element('button');
  btn.classList.add('zu-src-refresh'); btn.dataset.src = 'minimax';
  btn.closest = (sel) => (sel === '.zu-src-refresh' ? btn : null);   // 桩类自带 closest 恒 null，必须挂在 target 上
  panel.listeners.get('click')[0]({ target: btn });
  const reqs = h.window.__zusagePluginRequests;
  assert.equal(reqs.filter(r => r.action === 'quota-src').length, 1);
  assert.equal(reqs.filter(r => r.action === 'quota-src')[0].id, 'mimo');
  assert.equal(reqs.filter(r => r.action === 'quota-src')[0].enabled, true);
  const keyReq = reqs.filter(r => r.action === 'quota-src-key')[0];
  assert.equal(keyReq.id, 'mimo'); assert.equal(keyReq.field, 'cookie'); assert.equal(keyReq.value, 'userId=1; serviceToken=abc');
  assert.match(keyReq.requestId, /^zusage-\d+-\d+$/);
  const refreshReq = reqs.filter(r => r.action === 'quota-src-refresh')[0];
  assert.equal(refreshReq.id, 'minimax');

  void list; void ui;
});

test('issue #68: apiKey-mode BigModel/Z.ai provider shows its composite source with the built-in family title', () => {
  for (const [provider, source, title] of [['bigmodel-api-2', 'bigmodel:bigmodel-api-2', 'BigModel'], ['zai-api', 'zai:zai-api', 'Z.ai']]) {
    const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
    h.inject(); h.boot(); h.tick();
    const entry = Object.assign({}, QUOTA_OK, { plan: null, level: '' });
    h.window.__zusageUpdate({ remote_evidence: false, today: {}, not_local: [],
      quota: { active: source, byProvider: { [provider]: source }, sources: { [source]: entry } },
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
        last: { provider_id: provider, model: 'GLM-5.3' } }] });
    const chip = h.chipOf(ui.wrap);
    assert.ok(chip, provider + ' 应显示额度 chip');
    assert.match(chip.innerHTML, /5小时<\/span> 26%/);
    chip.listeners.get('mouseenter')[0].call(chip);
    assert.match(h.tipEl().innerHTML, new RegExp('套餐额度 · ' + title.replace('.', '\\.')));
    assert.doesNotMatch(h.tipEl().innerHTML, /自定义供应商/);
  }
});

test('custom-provider session shows ITS source via byProvider mapping (multi-window, no cross-leak)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  // 本 pane 会话在自定义 provider（MiniMax 官方域）；另一源的内置数据不得串显
  h.window.__zusageUpdate({ remote_evidence: false, today: {}, not_local: [],
    quota: {
      active: 'bigmodel', byProvider: { 'new-provider-mm': 'minimax' },
      sources: {
        bigmodel: Object.assign({}, QUOTA_OK),
        minimax: { status: 'ok', fetchedAt: NOW, stale: false, error: '', windows: { fiveHour: { percent: 42, resetsAt: null }, weekly: null } },
      },
    },
    recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
      last: { provider_id: 'new-provider-mm', model: 'MiniMax-M3' } }] });
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip, '自定义会话按 byProvider 映射显示自己的源');
  assert.match(chip.innerHTML, /5小时<\/span> 42%/, '是 MiniMax 的 42%，不是 bigmodel 的 26%');
  assert.doesNotMatch(chip.innerHTML, /26%/);
  // 未映射的自定义 provider（主进程没记录）：fail-closed 隐藏
  h.window.__zusageUpdate({ remote_evidence: false, today: {}, not_local: [],
    quota: { active: 'bigmodel', byProvider: {}, sources: { bigmodel: Object.assign({}, QUOTA_OK) } },
    recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
      last: { provider_id: 'new-provider-unknown', model: 'x' } }] });
  assert.equal(h.chipOf(ui.wrap), undefined, '未映射自定义 provider 不显示（不能证明数据归属）');
});


function selectionQuota() {
  return { active: 'bigmodel', byProvider: { 'new-provider-ds': 'deepseek:new-provider-ds' },
    sources: { bigmodel: QUOTA_OK, 'deepseek:new-provider-ds': {
      status: 'ok', label: 'DeepSeek', fetchedAt: NOW, stale: false, balance: { amount: 110, currency: 'CNY' },
    } } };
}

test('live composer model switch changes chip before any new database request completes', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main', {
    live: true, provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3',
  });
  h.inject(); h.boot(); h.tick();
  const data = h.payload({ quota: selectionQuota() });
  h.window.__zusageUpdate(data);
  assert.match(h.chipOf(ui.wrap).innerHTML, /5小时<\/span> 26%/);
  ui.marker.setAttribute('data-provider', 'new-provider-ds');
  ui.marker.setAttribute('data-model', 'deepseek-flash');
  h.mutate(ui.pane);
  assert.equal(h.chipOf(ui.wrap).innerHTML, '<span class="zu-qseg zu-qb-calm">余额 ¥110.00</span>');
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.match(h.tipEl().innerHTML, /账户余额 · DeepSeek/);
  assert.doesNotMatch(h.tipEl().innerHTML, /套餐额度 · BigModel/);
  assert.doesNotMatch(h.tipEl().innerHTML, /其他源.*deepseek:new-provider-ds/, '本 pane 自己的源不进「其他源」');
  assert.match(h.tipEl().innerHTML, /其他源.*bigmodel/, '真正的其他源（BigModel）仍列出');
  chip.listeners.get('click')[0].call(chip, { preventDefault() {}, stopPropagation() {} });
  const refresh = h.window.__zusagePluginRequests.filter(r => r.action === 'quota-refresh').at(-1);
  assert.equal(refresh.sourceId, 'deepseek:new-provider-ds', 'manual refresh targets this pane account only');
  assert.equal(data.recent[0].last.provider_id, 'account:bigmodel-individual-coding-plan', 'DB history has not changed');
  const reqs = h.window.__zusagePluginRequests.filter(r => r.action === 'quota-providers');
  assert.equal(reqs.length, 1, 'rapid changes replace the pending full selection snapshot');
  assert.equal(reqs[0].panes['workspace-main'].providerId, 'new-provider-ds');
  assert.equal(reqs[0].panes['workspace-main'].sid, 'sid_main');
  ui.marker.setAttribute('data-provider', 'account:bigmodel-individual-coding-plan');
  ui.marker.setAttribute('data-model', 'GLM-5.3-Flash');
  h.mutate(ui.pane);
  assert.match(h.chipOf(ui.wrap).innerHTML, /5小时<\/span> 26%/, 'switching back reuses the matching cached pool');
});

test('unmapped or empty live selection immediately removes old Coding Plan instead of using fallback', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main', {
    live: true, provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3',
  });
  h.inject(); h.boot(); h.tick();
  const data = h.payload({ quota: selectionQuota() });
  data.provider_fallback = 'account:bigmodel-individual-coding-plan';
  h.window.__zusageUpdate(data);
  ui.marker.setAttribute('data-provider', 'new-provider-unknown');
  h.mutate(ui.pane);
  assert.ok(!h.chipOf(ui.wrap));
  ui.marker.setAttribute('data-provider', '');
  ui.marker.setAttribute('data-model', '');
  h.mutate(ui.pane);
  h.window.__zusageUpdate(data);
  assert.equal(h.chipOf(ui.wrap), undefined, 'explicit empty does not resurrect a global account fallback');
});

test('two pane live selections stay independent and missing markers never read a sibling pane', () => {
  const h = harness();
  const a = h.buildComposer('workspace-main', 'sid_main', {
    live: true, provider: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3',
  });
  const b = h.buildComposer('split-b', 'sid_b', { live: true, provider: 'new-provider-ds', model: 'deepseek-flash' });
  h.inject(); h.boot(); h.tick();
  const data = h.payload({ quota: selectionQuota() });
  data.recent.push({ sid: 'sid_b', workspace_identity: '', context_window: 200000,
    last: { provider_id: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3' } });
  h.window.__zusageUpdate(data);
  assert.match(h.chipOf(a.wrap).innerHTML, /5小时<\/span> 26%/);
  assert.match(h.chipOf(b.wrap).innerHTML, /余额 ¥110.00/);
  const last = h.window.__zusagePluginRequests.filter(r => r.action === 'quota-providers').at(-1);
  assert.equal(last.panes['workspace-main'].providerId, 'account:bigmodel-individual-coding-plan');
  assert.equal(last.panes['split-b'].providerId, 'new-provider-ds');
  b.marker.remove();
  h.mutate(b.pane);
  assert.equal(h.chipOf(b.wrap), undefined, 'missing marker on B must not borrow A or stale B selection');
  assert.match(h.chipOf(a.wrap).innerHTML, /5小时<\/span> 26%/);
});

test('session replacement and disposal invalidate live model selection observers', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main', {
    live: true, provider: 'new-provider-ds', model: 'deepseek-flash',
  });
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: selectionQuota() }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /余额 ¥110.00/);
  ui.pane.sid = 'sid_next';
  h.mutate(ui.pane);
  assert.equal(h.chipOf(ui.wrap), undefined, 'session root changed before coordinator rebinding');
  const obs = h.observers.find(o => o.target === ui.pane);
  assert.ok(obs.connected);
  h.window.__zusageDispose();
  assert.equal(obs.connected, false);
  ui.marker.setAttribute('data-provider', 'account:bigmodel-individual-coding-plan');
  h.mutate(ui.pane);
  assert.ok(!h.chipOf(ui.wrap));
});


test('older host pane that never supplied a model marker keeps the completed-request fallback', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main', { live: true });
  ui.marker.remove();
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /5小时<\/span> 26%/);
  const snapshot = h.window.__zusagePluginRequests.filter(r => r.action === 'quota-providers').at(-1);
  assert.equal(snapshot.panes['workspace-main'].providerId, 'account:bigmodel-individual-coding-plan');
});


test('older main-process custom entries without labels never use a BigModel tooltip title', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main', {
    live: true, provider: 'new-provider-ds', model: 'deepseek-flash',
  });
  h.inject(); h.boot(); h.tick();
  const quota = selectionQuota();
  delete quota.sources['deepseek:new-provider-ds'].label;
  h.window.__zusageUpdate(h.payload({ quota }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.match(h.tipEl().innerHTML, /账户余额 · 自定义供应商/);
  assert.doesNotMatch(h.tipEl().innerHTML, /账户余额 · BigModel|套餐额度 · BigModel/);
});


test('legacy pane fallback recovers after the root SID changes ahead of coordinator rebinding', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main', { live: true });
  ui.marker.remove();
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: selectionQuota() }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /5小时<\/span> 26%/);
  ui.pane.sid = 'sid_next';
  h.mutate(ui.pane);
  assert.equal(h.chipOf(ui.wrap), undefined, 'SID mismatch hides old session data during the transition');
  ui.editor.sid = 'sid_next';
  h.tick();
  const data = h.payload({ quota: selectionQuota() });
  data.recent.push({ sid: 'sid_next', workspace_identity: '', context_window: 200000,
    last: { provider_id: 'new-provider-ds', model: 'deepseek-flash' } });
  h.window.__zusageUpdate(data);
  h.tick(); h.tick();
  assert.match(h.chipOf(ui.wrap).innerHTML, /余额 ¥110.00/, 'new session recovers DB fallback without a live model marker');
  const request = h.window.__zusagePluginRequests.filter(r => r.action === 'quota-providers').at(-1);
  assert.equal(request.panes['workspace-main'].providerId, 'new-provider-ds');
  assert.equal(request.panes['workspace-main'].sid, 'sid_next');
});


test('sub2api subscription chip and tooltip expose daily/weekly/monthly USD limits, not a wallet balance', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const quota = { active: 'custom:gw', byProvider: { gw: 'custom:gw' }, sources: {
    'custom:gw': { status: 'ok', label: 'sub2api', kind: 'plan', fetchedAt: NOW, stale: false,
      windows: { daily: { percent: 33.1, used: 33.0984, total: 100, remaining: 66.9016, currency: 'USD', resetsAt: null },
        weekly: { percent: 18.4, used: 45.91, total: 250, remaining: 204.09, currency: 'USD', resetsAt: null },
        monthly: { percent: 6.9, used: 69.39, total: 1000, remaining: 930.61, currency: 'USD', resetsAt: null } },
      subscription: { name: 'Fixture plan', expiresAt: '2027-04-25T13:06:06+08:00' } },
  } };
  h.window.__zusageUpdate(h.payload({ provider: 'gw', model: 'gpt-fixture', quota }));
  const chip = h.chipOf(ui.wrap);
  assert.match(chip.innerHTML, /今日<\/span> 33%.*7天<\/span> 18%.*本月<\/span> 7%/);
  assert.doesNotMatch(chip.innerHTML, /余额/);
  chip.listeners.get('mouseenter')[0].call(chip);
  const html = h.tipEl().innerHTML;
  assert.match(html, /套餐额度 · sub2api/);
  assert.match(html, /每日窗口.*\$33\.10 \/ \$100\.00.*剩余 \$66\.90/);
  assert.match(html, /本周窗口.*\$45\.91 \/ \$250\.00/);
  assert.match(html, /月度窗口.*\$69\.39 \/ \$1000\.00/);
  assert.match(html, /订阅截止/);
  assert.doesNotMatch(html, /额度明细/, '明细拼在窗口行内，不再有独立同名行');
  assert.match(html, /每日窗口<\/b><span>已用 33\.1% · \$33\.10 \/ \$100\.00 · 剩余 \$66\.90/);
  assert.doesNotMatch(html, /重置 /, 'expiry is not a reset timestamp');
});


test('sub2api key quota without windows is shown as quota, never as wallet balance', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: 'gw', quota: { active: 'custom:gw', byProvider: { gw: 'custom:gw' }, sources: {
    'custom:gw': { status: 'ok', label: 'sub2api', fetchedAt: NOW, stale: false,
      quotaSummary: { limit: 10, used: 3, remaining: 7, currency: 'USD' } },
  } } }));
  const chip = h.chipOf(ui.wrap);
  assert.match(chip.innerHTML, /额度 \$7\.00/);
  assert.doesNotMatch(chip.innerHTML, /余额/);
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.match(h.tipEl().innerHTML, /Key 总额度.*\$3\.00 \/ \$10\.00.*剩余 \$7\.00/);
});


test('plan period label distinguishes auto-renew charge date from fixed expiry', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, {
    plan: { version: 'V1', productName: 'GLM Coding Max', validStart: '2026-03-14', validEnd: '', renewAt: '2027-03-14' },
  }) }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.match(h.tipEl().innerHTML, /下次续费 2027-03-14/);
  assert.doesNotMatch(h.tipEl().innerHTML, /有效期至/);
  // 周期无法确认（未来 valid 被拒后全空）：只显示套餐名，不猜日期
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, {
    plan: { version: 'V1', productName: 'GLM Coding Max', validStart: '', validEnd: '' },
  }) }));
  const chip2 = h.chipOf(ui.wrap);
  chip2.listeners.get('mouseenter')[0].call(chip2);
  assert.match(h.tipEl().innerHTML, /套餐额度 · GLM Coding Max · V1/);
  assert.doesNotMatch(h.tipEl().innerHTML, /有效期至|下次续费/);
});

test('issue #68 (mutation review): family title strictly follows provider id shape', () => {
  for (const [provider, source, title] of [['zai-api-3', 'zai:zai-api-3', 'Z\\.ai'], ['bigmodel-api', 'bigmodel:bigmodel-api', 'BigModel'],
    ['zai-api-x', 'custom:zai-api-x', '自定义供应商'], ['bigmodel-apix', 'custom:bigmodel-apix', '自定义供应商']]) {
    const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
    h.inject(); h.boot(); h.tick();
    const entry = Object.assign({}, QUOTA_OK, { plan: null, level: '' });
    h.window.__zusageUpdate({ remote_evidence: false, today: {}, not_local: [],
      quota: { active: source, byProvider: { [provider]: source }, sources: { [source]: entry } },
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
        last: { provider_id: provider, model: 'GLM-5.3' } }] });
    const chip = h.chipOf(ui.wrap);
    assert.ok(chip, provider);
    chip.listeners.get('mouseenter')[0].call(chip);
    assert.match(h.tipEl().innerHTML, new RegExp((title === '自定义供应商' ? '' : '套餐额度 · ') + title), provider);
    if (title !== '自定义供应商') assert.doesNotMatch(h.tipEl().innerHTML, /自定义供应商/, provider);
  }
});
/* ---------- v102 预设模板：chips 渲染契约 + baseUrl 写入 + openExternal 桥 ---------- */
test("source rows carry preset chips, the console key link and highlight the active baseUrl", () => {
  assert.match(source, /class="zu-src-preset/);
  assert.match(source, /zu-src-preset[^>]*\.on/, "active preset gets the on class");
  assert.match(source, /zu-src-keyurl/);
  assert.match(source, /获取 Key/);
  assert.match(source, /data-base=/);
});

test("preset chip click writes secrets baseUrl via the whitelist channel; key link opens the bridge", () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  void ui;
  h.window.__zusagePluginUpdate({ quotaEnabled: true, quotaSources: [
    { id: 'minimax', label: 'MiniMax', kind: 'plan', enabled: true, credentialFields: ['apiKey'], keyConfigured: true, status: 'ok' },
  ] });
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  const preset = new Element('button');
  preset.classList.add('zu-src-preset'); preset.dataset.src = 'minimax'; preset.dataset.base = 'https://api.minimaxi.com';
  preset.closest = (sel) => (sel === '.zu-src-preset' ? preset : null);
  panel.listeners.get('click')[0]({ target: preset });
  const preq = h.window.__zusagePluginRequests.filter(r => r.action === 'quota-src-key').pop();
  assert.equal(preq.id, 'minimax');
  assert.equal(preq.field, 'baseUrl');
  assert.equal(preq.value, 'https://api.minimaxi.com');
  h.window.zcode = { openExternal: (u) => { h.window.__opened = u; } };
  const keyBtn = new Element('button');
  keyBtn.classList.add('zu-src-keyurl'); keyBtn.dataset.url = 'https://platform.minimaxi.com';
  keyBtn.getAttribute = (k) => (k === 'data-url' ? 'https://platform.minimaxi.com' : null);   // 桩的 dataset 按裸键查，覆写对齐真实 DOM
  keyBtn.closest = (sel) => (sel === '.zu-src-keyurl' ? keyBtn : null);
  panel.listeners.get('click')[0]({ target: keyBtn });
  assert.equal(h.window.__opened, 'https://platform.minimaxi.com');
});

test("refresh and key buttons expose native titles; switched-off sources disable refresh", () => {
  assert.ok(source.includes('跳过缓存，立即重新查询该源'), "refresh button title");
  assert.ok(source.includes('" title="\' + L("打开控制台获取 API Key"'), "key link title reuses the aria label");
  assert.ok(source.includes('(sv.enabled ? "" : " disabled") + \' aria-busy=\' + (!!sv.busy) + \' >↻</button>\'') || /sv\.enabled && !sv\.busy \? "" : " disabled"/.test(source), "off sources render a disabled refresh");
  assert.ok(source.includes('.zu-src-refresh:disabled{opacity:.4;cursor:default}'), "disabled refresh styling");
  assert.ok(source.includes('disabled: L("已关闭", "off")'), "disabled status maps to a localized label");
});

test('zcode-start pool: chip shows a plan-pool segment; source routing prefers zcode-start over family', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const NOW2 = Date.now();
  h.window.__zusageUpdate(h.payload({
    provider: 'account:bigmodel-start-plan', model: 'GLM-5.3-Flash',
    quota: {
      status: 'ok', providerId: 'account:bigmodel-start-plan', fetchedAt: NOW2, stale: false, error: '', level: 'Start',
      windows: { plan: { percent: 9.3, resetsAt: NOW2 + 2 * 86400e3, expires: true } },
      models: ['GLM-5.3-Flash', 'GLM-5.3'],
      plan: { productName: 'ZCode 1024 Dev Day', validStart: '2026-10-23 20:09', validEnd: '2026-10-26 09:00' },
    },
  }));
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip, 'chip mounted for start-plan provider');
  assert.equal(chip.innerHTML, '<span class="zu-qseg zu-qb-calm"><span class="zu-qlabel">套餐</span> 9%</span>');
  assert.equal(chip.getAttribute('aria-label'), '套餐已用 套餐 9%');
  chip.listeners.get('mouseenter')[0].call(chip);
  const html = h.tipEl().innerHTML;
  assert.match(html, /套餐额度 · ZCode 1024 Dev Day · 有效期至 2026-10-26 09:00/);
  assert.match(html, /套餐池<\/b><span>已用 9\.3% · 到期 \d{4}-\d\d-\d\d \d\d:\d\d/);   // one_time 池用「到期」不用「重置」
  assert.match(html, /<span class="qt-cur">GLM-5\.3-Flash<\/span>, GLM-5\.3/);
  assert.match(html, /账号级：同账号所有模型共用/);
  chip.listeners.get('mouseleave')[0].call(chip);
  assert.equal(h.tipEl().style.display, 'none');
});

test('zcode-start routing: start-plan pane never displays the coding-plan family source', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const NOW2 = Date.now();
  h.window.__zusageUpdate(h.payload({
    provider: 'account:bigmodel-start-plan', model: 'GLM-5.3-Flash',
    quota: {
      active: 'bigmodel', byProvider: { 'account:bigmodel-start-plan': 'zcode-start' },
      sources: {
        bigmodel: { status: 'ok', providerId: 'account:bigmodel-individual-coding-plan', fetchedAt: NOW2, stale: false, error: '', level: 'max',
          windows: { fiveHour: { percent: 3, resetsAt: NOW2 + 3600e3, details: [] }, weekly: null }, models: [],
          plan: { productName: 'GLM Coding Max', version: 'V1', validStart: '2026-02-28', validEnd: '2027-02-28' } },
        'zcode-start': { status: 'ok', providerId: 'account:bigmodel-start-plan', fetchedAt: NOW2, stale: false, error: '', level: 'Start',
          windows: { plan: { percent: 9.3, resetsAt: NOW2 + 2 * 86400e3, expires: true } }, models: ['GLM-5.3-Flash', 'GLM-5.3'],
          plan: { productName: 'ZCode 1024 Dev Day', validStart: '2026-10-23 20:09', validEnd: '2026-10-26 09:00' } },
      },
    },
  }));
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip, 'chip mounted');
  assert.equal(chip.innerHTML, '<span class="zu-qseg zu-qb-calm"><span class="zu-qlabel">套餐</span> 9%</span>', 'shows the zcode-start pool, not bigmodel 5h');
  chip.listeners.get('mouseenter')[0].call(chip);
  const html = h.tipEl().innerHTML;
  assert.match(html, /ZCode 1024 Dev Day/);
  assert.doesNotMatch(html, /GLM Coding Max/);
  assert.match(html, /其他源<\/b><span>bigmodel 3%/);   // 其他启用源摘要列出 bigmodel 家族（窗口百分比）
});

/* ---------- 2026-10-24 夜间扫描回归：转义 / 签名幂等 / busy 类保留 ---------- */

test('remote currency strings are escaped in chip and tooltip (no injection sinks)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const evil = '<img src=x onerror=alert(1)>';
  h.window.__zusageUpdate(h.payload({
    quota: {
      status: 'ok', fetchedAt: Date.now(), stale: false, error: '', level: 'lite',
      balance: { amount: 12.34, currency: evil },
      models: ['GLM-5.3-Flash'],
    },
  }));
  const chip = h.chipOf(ui.wrap);
  assert.ok(chip, 'balance chip mounted');
  assert.ok(chip.innerHTML.indexOf('&lt;img src=x onerror=alert(1)&gt; 12.34') >= 0,
    'currency escaped in chip: ' + chip.innerHTML);
  assert.ok(chip.innerHTML.indexOf('<img') < 0, 'no raw tag in chip');
  assert.ok(chip.getAttribute('aria-label').indexOf('<img src=x') >= 0,
    'aria-label keeps plain text (no entities)');
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl().innerHTML;
  assert.ok(tip.indexOf('<img') < 0, 'no raw tag in tooltip');
  assert.ok(tip.indexOf('&lt;img src=x') >= 0, 'currency escaped in tooltip balance row');
});

test('sub2api window amounts and quotaSummary escape their currency; parts labels not double-escaped', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const NOW2 = Date.now();
  h.window.__zusageUpdate(h.payload({
    quota: {
      status: 'ok', fetchedAt: NOW2, stale: false, error: '', level: 'lite',
      windows: { daily: { percent: 40, used: 0.4, total: 1, remaining: 0.6, currency: '"inj"' } },
      quotaSummary: { used: 1, limit: 10, remaining: 9, currency: 'US&L' },
      balance: { amount: 5, currency: 'USD', parts: [{ label: 'A&B', amount: '3' }, { label: '<i>x</i>', amount: 2 }] },
      models: [],
    },
  }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl().innerHTML;
  assert.ok(tip.indexOf('&quot;inj&quot;') >= 0, 'window currency escaped: ' + tip.slice(0, 400));
  assert.ok(tip.indexOf('US&amp;L') >= 0, 'summary currency escaped');
  assert.ok(tip.indexOf('A&amp;B') >= 0 && tip.indexOf('A&amp;amp;B') < 0,
    'parts label escaped exactly once (was double-escaped)');
  assert.ok(tip.indexOf('&lt;i&gt;x&lt;/i&gt;') >= 0, 'parts label tag escaped');
  assert.ok(tip.indexOf('<i>') < 0, 'no raw tag from parts');
});

test('quotaTip rebuilds only when content changes (selection/scroll survive periodic reconciles)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  const chip = h.chipOf(ui.wrap);
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl();
  let sets = 0, cur = tip.innerHTML;
  Object.defineProperty(tip, 'innerHTML', {
    get: () => cur, set: v => { sets++; cur = v; }, configurable: true,
  });
  chip.listeners.get('mouseenter')[0].call(chip);   // 同数据再进：签名命中，不重写
  assert.equal(sets, 0, 'same data → no innerHTML rewrite');
  h.window.__zusageUpdate(h.payload({ quota: withPct(45) }));
  chip.listeners.get('mouseenter')[0].call(chip);   // 数据真变：重写一次
  assert.equal(sets, 1, 'changed data → single rewrite');
});

test('quota chip busy tracks query snapshots, not a fixed animation timer', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: { ...QUOTA_OK, busy: true } }));
  assert.ok(h.chipOf(ui.wrap).classList.contains('zu-qbusy'));
  h.window.__zusageUpdate(h.payload({ quota: { ...withPct(33), busy: true } }));
  assert.ok(h.chipOf(ui.wrap).classList.contains('zu-qbusy'));
  h.window.__zusageUpdate(h.payload({ quota: { ...withPct(33), busy: false } }));
  assert.equal(h.chipOf(ui.wrap).classList.contains('zu-qbusy'), false);
  assert.equal(h.chipOf(ui.wrap).getAttribute('aria-busy'), 'false');
});


test('quota configuration failure returns to the previous visible switch state', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  const toggle = new Element('input');
  toggle.classList.add('zu-quota-enable'); toggle.checked = false;
  panel.listeners.get('change')[0]({ target: toggle });
  h.tick();
  assert.ok(!h.chipOf(ui.wrap));
  const req = h.window.__zusagePluginRequests.findLast(r => r.action === 'quota');
  h.window.__zusagePluginResult({ id: req.requestId, ok: false, error: 'fixture write denied' });
  h.tick();
  assert.ok(h.chipOf(ui.wrap), 'failed save restores the previous quota setting');
  assert.match(panel.querySelector('.zu-settings-feedback-status').textContent, /保存失败/);
});

test('source save failure restores toggle and keeps credentials write-only', () => {
  const h = harness(); h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  const toggle = new Element('input');
  toggle.classList.add('zu-src-enable'); toggle.dataset.src = 'mimo'; toggle.checked = true;
  panel.listeners.get('change')[0]({ target: toggle });
  const req = h.window.__zusagePluginRequests.findLast(r => r.action === 'quota-src');
  h.window.__zusagePluginResult({ id: req.requestId, ok: false });
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, undefined, 'older main processes never leave controls disabled');
  const field = new Element('input'); field.type = 'password'; field.classList.add('zu-src-field');
  Object.assign(field.dataset, { src: 'mimo', field: 'cookie' }); field.value = 'fixture-secret';
  panel.listeners.get('change')[0]({ target: field });
  const keyReq = h.window.__zusagePluginRequests.findLast(r => r.action === 'quota-src-key');
  h.window.__zusagePluginResult({ id: keyReq.requestId, ok: true });
  assert.equal(field.value, '', 'successful writes clear the local password field');
});

test('refresh keyboard activation uses Enter once and Space on keyup without scrolling', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick(); h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  const chip = h.chipOf(ui.wrap); let clicks = 0, prevented = 0;
  chip.click = () => { clicks++; };
  const event = key => ({ key, preventDefault() { prevented++; } });
  chip.listeners.get('keydown')[0].call(chip, event('Enter'));
  chip.listeners.get('keydown')[0].call(chip, event(' '));
  assert.equal(clicks, 1);
  chip.listeners.get('keyup')[0].call(chip, event(' '));
  assert.equal(clicks, 2); assert.equal(prevented, 3);
});


test('a late successful credential save does not erase newly edited input', () => {
  const h = harness(); h.buildComposer('workspace-main', 'sid_main'); h.inject(); h.boot(); h.tick();
  const panel = h.body.children.find(e => e.classList.contains('zu-settings'));
  const field = new Element('input'); field.type = 'password'; field.classList.add('zu-src-field');
  Object.assign(field.dataset, { src: 'mimo', field: 'cookie' }); field.value = 'first-fixture-key';
  panel.listeners.get('change')[0]({ target: field });
  const req = h.window.__zusagePluginRequests.findLast(r => r.action === 'quota-src-key');
  field.value = 'new-fixture-key'; panel.listeners.get('input')[0]({ target: field });
  h.window.__zusagePluginResult({ id: req.requestId, ok: true });
  assert.equal(field.value, 'new-fixture-key');
});
