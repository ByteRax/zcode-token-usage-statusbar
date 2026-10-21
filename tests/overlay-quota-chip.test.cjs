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
  querySelector(k) {
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
    if (sel !== 'circle') return [];
    return this.children.filter(e => e.tagName === 'CIRCLE').concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
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
  /* 开关真值来自主进程推送的插件状态（config.json quota_enabled），不是 localStorage */
  if (quotaOn) window.__zusagePluginState = { quotaEnabled: true };
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(); let id = 0;
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' }, localStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.quotaTest = { instances: function() { return instances; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
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
  function payload({ provider = 'account:bigmodel-individual-coding-plan', model = 'GLM-5.3-Flash', quota } = {}) {
    const out = { remote_evidence: false, today: {}, not_local: [],
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
        last: { provider_id: provider, model } }] };
    if (quota !== undefined) out.quota = quota;
    return out;
  }
  const chipOf = wrap => wrap.children.find(e => e.classList.contains('zu-quota'));
  const tipEl = () => body.children.find(e => e.className === 'tip zusage-quota-tip');
  return { window, body, inject, tick, boot, buildComposer, payload, chipOf, tipEl };
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
    '<span class="zu-qseg ok">5小时 26%</span><span class="zu-qsep">|</span><span class="zu-qseg ok">7天 12%</span>');
  assert.equal(chip.getAttribute('aria-label'), '套餐已用 5小时 26%，7天 12%');
  assert.equal(chip.getAttribute('role'), 'status');
  assert.ok(chip.listeners.get('click') && chip.listeners.get('mouseenter'));
});

test('display gates: toggle off, unknown provider (new session), custom provider, old main process without quota field', () => {
  const off = harness({ quotaOn: false }), u0 = off.buildComposer('workspace-main', 'sid_main');
  off.inject(); off.boot(); off.tick();
  off.window.__zusageUpdate(off.payload({ quota: QUOTA_OK }));
  assert.equal(off.chipOf(u0.wrap), undefined, 'default off hides chip');

  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ provider: '', quota: QUOTA_OK }));   // 会话首个 main_turn 未完成
  assert.equal(h.chipOf(ui.wrap), undefined, 'no provider yet → hidden');
  h.window.__zusageUpdate(h.payload({ provider: 'new-provider', quota: QUOTA_OK }));   // 自定义 provider：不属套餐池
  assert.equal(h.chipOf(ui.wrap), undefined, 'custom provider → hidden');
  h.window.__zusageUpdate(h.payload());   // 旧主进程：payload 无 quota 字段
  assert.equal(h.chipOf(ui.wrap), undefined, 'no quota field → hidden, no throw');
  h.window.__zusageUpdate(h.payload({ quota: { status: 'not_configured', fetchedAt: 0, stale: false, error: '' } }));
  assert.equal(h.chipOf(ui.wrap), undefined, 'not_configured → hidden');
  h.window.__zusageUpdate(h.payload({ quota: { status: 'unsupported', reason: 'provider', fetchedAt: 0, stale: false, error: '' } }));
  assert.equal(h.chipOf(ui.wrap), undefined, 'unsupported → hidden');
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

test('segments use quota thresholds 80/95/100; mixed windows keep their own bands', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: withPct(79.6) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg ok">5小时 80%<\/span>/);   // 档位按原始值判（79.6 < 80 为 ok），显示四舍五入
  h.window.__zusageUpdate(h.payload({ quota: withPct(80) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg warm">5小时 80%<\/span>/);
  h.window.__zusageUpdate(h.payload({ quota: withPct(95) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg hot">5小时 95%<\/span>/);
  h.window.__zusageUpdate(h.payload({ quota: withPct(100) }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /zu-qseg exc">5小时 100%<\/span>/);
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { windows: { fiveHour: { percent: 96, resetsAt: null, details: [] }, weekly: { percent: 10, resetsAt: null, details: [] } } }) }));
  assert.equal(h.chipOf(ui.wrap).innerHTML,
    '<span class="zu-qseg hot">5小时 96%</span><span class="zu-qsep">|</span><span class="zu-qseg ok">7天 10%</span>');
});

test('failures keep the last good value with a warning mark; no value shows the mark alone; stale dims', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { status: 'network_error', error: 'HTTP 502' }) }));
  let chip = h.chipOf(ui.wrap);
  assert.match(chip.innerHTML, /7天 12%<\/span><span class="zu-qwarn">⚠<\/span>/);   // 旧值保留 + 警示标
  h.window.__zusageUpdate(h.payload({ quota: { status: 'auth_failed', fetchedAt: 0, stale: false, error: 'HTTP 401' } }));
  chip = h.chipOf(ui.wrap);
  assert.equal(chip.innerHTML, '<span class="zu-qwarn">⚠</span>');
  assert.equal(chip.getAttribute('aria-label'), '认证失效：重新登录 ZCode 后自动恢复');
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { stale: true }) }));
  chip = h.chipOf(ui.wrap);
  assert.equal(chip.className, 'zu-quota zu-qstale');
  // ok 态但接口回空窗口：没有可显示的数字 → 不渲染空 chip
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { windows: { fiveHour: null, weekly: null } }) }));
  assert.equal(h.chipOf(ui.wrap), undefined);
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
  assert.ok(chip.classList.contains('zu-qbusy'));
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
  h.window.__zusagePluginUpdate({ quotaEnabled: false });   // 主进程回推：config quota_enabled 已关
  h.tick();
  assert.equal(h.chipOf(ui.wrap), undefined, 'main-process truth off → chip removed at heavy tick');
  h.window.__zusagePluginUpdate({ quotaEnabled: true });
  h.tick();
  assert.ok(h.chipOf(ui.wrap), 'truth on again → chip back (lastQuota retained)');
  h.window.quotaTest.instances()[0].dispose();
  assert.equal(h.chipOf(ui.wrap), undefined);
  assert.equal(ui.wrap.children.length, 1);
  assert.equal(ui.wrap.children[0], ui.btn);
});

test('settings checkbox is config-backed: change emits a "quota" plugin request and updates optimistically', () => {
  const h = harness({ quotaOn: false }), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  assert.equal(h.chipOf(ui.wrap), undefined);
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
  h.tick();
  assert.ok(h.chipOf(ui.wrap), 'optimistic update shows the chip before the main process confirms');
  void inst;
});

test('settings panel exposes the config-backed quota toggle (default off) with the credential disclosure', () => {
  assert.match(source, /quotaEnabled: !!\(window\.__zusagePluginState && window\.__zusagePluginState\.quotaEnabled === true\)/);
  assert.doesNotMatch(source, /show: \{[^}]*quota/);   // 不是 localStorage 显示项：真值只在 config.json
  assert.match(source, /<input type="checkbox" class="zu-quota-enable">/);
  assert.match(source, /pluginRequest\("quota", t2\.checked\)/);
  assert.match(source, /凭据仅在内存使用、不落盘、不进日志与诊断：内置套餐发往 bigmodel\.cn \/ api\.z\.ai 官方域/);   // 阶段 3 分域披露
  assert.match(source, /zu-src-list/);   // ⚙ 源列表容器
  assert.match(source, /pluginRequest\("quota-src-key", \{ id: t2\.dataset\.src, field: t2\.dataset\.field, value: t2\.value \}\)/);
  assert.match(source, /\.zu-quota\{display:inline-flex;align-items:center;gap:5px;height:1\.75rem/);
  assert.match(source, /\.zu-qseg\.exc\{color:var\(--color-destructive,#ff2d55\)/);
  assert.match(source, /\.zu-qsep\{color:var\(--color-foreground-subtle/);
  assert.match(source, /\.zu-quota\[data-zusage-light\] \.zu-qseg\{color:#0f9d6c\}/);
  assert.doesNotMatch(source, /zu-qring/);   // v96 起环形已删（分段样式）
  assert.match(source, /\.zusage-quota-tip,\.zu-quota,/);   // 代际清理选择器含 chip 与其 tooltip
});

test('balance-type quota renders a single amount segment (stage-3 adapter contract)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { balance: { amount: 100, currency: 'CNY' } }) }));
  const chip = h.chipOf(ui.wrap);
  assert.equal(chip.innerHTML, '<span class="zu-qseg ok">余额 ¥100.00</span>');
  assert.equal(chip.getAttribute('aria-label'), '余额 ¥100.00');
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { balance: { amount: 12.5, currency: 'USD' } }) }));
  assert.equal(h.chipOf(ui.wrap).innerHTML, '<span class="zu-qseg ok">余额 $12.50</span>');
  h.window.__zusageUpdate(h.payload({ quota: Object.assign({}, QUOTA_OK, { balance: { amount: 3, currency: 'EUR' } }) }));
  assert.equal(h.chipOf(ui.wrap).innerHTML, '<span class="zu-qseg ok">余额 EUR 3.00</span>');
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
  assert.match(chip.innerHTML, /5小时 26%/);
  // 回退指向自定义 provider（理论态）：不显示
  const out2 = Object.assign({}, out, { provider_fallback: 'new-provider-4' });
  h.window.__zusageUpdate(out2);
  assert.equal(h.chipOf(ui.wrap), undefined);
  // 无回退字段（旧主进程）：维持隐藏
  h.window.__zusageUpdate(h.payload({ provider: '' }));
  assert.equal(h.chipOf(ui.wrap), undefined);
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
  assert.match(chip.innerHTML, /5小时 26%/);
  // 平铺旧形状仍兼容
  h.window.__zusageUpdate(h.payload({ quota: QUOTA_OK }));
  assert.match(h.chipOf(ui.wrap).innerHTML, /5小时 26%/);
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
  assert.equal(reqs.filter(r => r.action === 'quota-src-refresh')[0].id, 'minimax');
  void list; void ui;
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
  assert.match(chip.innerHTML, /5小时 42%/, '是 MiniMax 的 42%，不是 bigmodel 的 26%');
  assert.doesNotMatch(chip.innerHTML, /26%/);
  // 未映射的自定义 provider（主进程没记录）：fail-closed 隐藏
  h.window.__zusageUpdate({ remote_evidence: false, today: {}, not_local: [],
    quota: { active: 'bigmodel', byProvider: {}, sources: { bigmodel: Object.assign({}, QUOTA_OK) } },
    recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
      last: { provider_id: 'new-provider-unknown', model: 'x' } }] });
  assert.equal(h.chipOf(ui.wrap), undefined, '未映射自定义 provider 不显示（不能证明数据归属）');
});
