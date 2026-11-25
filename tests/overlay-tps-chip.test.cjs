const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v146 精简模式速率 chip（.zu-tsb）：整 IIFE 执行 + instances 接缝（overlay-quota-chip 同款
 * 夹具）。夹具：输入卡片 group/toolbar 工具行放 wrapper span > button[chat-context-usage-trigger]，
 * localStorage 预置 zusage3.theme=compact，推带 last.tps 的 payload；断言 chip 挂载位置
 * （重置卡/额度组 wrapper 左侧）、DB 回退值与档位类、无数据隐藏、非精简主题门控摘除、
 * 签名幂等/位置兜回、tooltip 摘要行逐格开关、「打开设置」按钮开面板、dispose 清理。 */
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
    if (el === ref) return el;   // 自插=已就位（真实 DOM 为 no-op；桩走 remove+splice 会把条目塞回两次）
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
    if (sel === 'circle') return this.children.filter(e => e.tagName === 'CIRCLE').concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    if (sel === '.zu-sr-only') return this.children.filter(e => e.classList.contains('zu-sr-only')).concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    if (sel === '.it' || sel === '.zu-sub') return [];
    const m = /^\[(data-[a-z-]+|data-testid)(?:="([^"]*)")?\]$/.exec(sel);
    if (m) {   // gitMount 的前导区发现依赖属性选择器（v147 速率 chip 同源）
      const key = m[1], val = m[2];
      const hit = e => (val === undefined ? e.getAttribute(key) !== null : e.getAttribute(key) === val);
      return this.children.filter(hit).concat(
        ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    }
    return [];
  }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return k === 'data-pane-id' ? !!this.pid : k === 'data-session-id' ? !!this.sid : Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return k === 'data-pane-id' ? (this.pid || null) : k === 'data-session-id' ? (this.sid || null) : (this.dataset[k] !== undefined ? this.dataset[k] : null); }
  getBoundingClientRect() { return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 }; }
}

function harness({ theme = 'compact', show } = {}) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  const store = new Map([['zusage3.theme', theme], ['zusage3.tipHoverMs', '0']]);   // v440：门槛关直通（本文件测开门后行为；门槛链由 overlay-tip-activation 锁）
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' }, localStorage,
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.tpsTest = { instances: function() { return instances; }, state: function() { return state; }, setBarTheme: function(t) { setBarTheme(t); } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function buildComposer(pid, sid, { leading = true } = {}) {
    const card = body.appendChild(new Element());
    const row = card.appendChild(new Element());
    row.className = 'group/toolbar flex items-end gap-3';
    let leadWrap = null, cua = null;
    if (leading) {   // v147：速率 chip 挂前导区（git chip 同款发现面）
      leadWrap = row.appendChild(new Element('span'));
      leadWrap.setAttribute('data-composer-leading-content', 'true');
      cua = leadWrap.appendChild(new Element('button'));
      cua.setAttribute('data-testid', 'v4-composer-cua-entry');
    }
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
    return { card, row, wrap, btn, editor, leadWrap, cua };
  }
  function payload({ tps, project } = {}) {
    const last = { provider_id: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-Flash' };
    if (tps !== undefined) last.tps = tps;
    return { remote_evidence: false, today: { total: 12000, requests: 4 }, not_local: [],
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
        last_turn: { total: 5200, requests: 2 }, last, ...(project ? { project } : {}) }] };
  }
  const chipOf = root => {
    const scan = e => {
      if (e.classList && e.classList.contains('zu-tsb')) return e;
      for (const c of e.children || []) { const hit = scan(c); if (hit) return hit; }
      return null;
    };
    return scan(root);
  };
  const barEl = () => body.children.find(e => /zusage-root/.test(e.className || ''));
  const tipEl = () => body.children.find(e => e.classList.contains('zusage-tps-tip'));
  const panelEl = () => body.children.find(e => e.classList.contains('zu-settings'));
  return { window, body, store, inject, tick, boot, buildComposer, payload, chipOf, barEl, tipEl, panelEl };
}

test('compact theme: tps chip mounts in the leading area, taking the git slot (after cua) when git is absent', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  const chip = h.chipOf(ui.row);
  assert.ok(chip, 'chip mounted');
  assert.equal(chip.parentElement, ui.leadWrap, 'chip lives in the leading content group (git chip home)');
  assert.equal(ui.cua.nextElementSibling, chip, 'git absent -> chip takes the git anchor slot right after the cua button');
  assert.equal(chip.innerHTML, '<span class="zu-live ok"><span class="zu-sp-label"></span><span class="zu-sp-val">87.3</span><span class="zu-sp-unit dim">t/s</span></span>', 'DB fallback renders value + unit with the 70-150 band class, no label (v452，与完成态同面)');
  assert.equal(chip.getAttribute('aria-label'), '生成速度 87.3 t/s');
  assert.ok(chip.tabIndex === 0, 'keyboard reachable');
});

test('git chip present: rate re-anchors before it ([cua][rate][git]); trailing fallback without leading content', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  const fakeGit = new Element('span');
  fakeGit.className = 'zu-git';
  ui.leadWrap.appendChild(fakeGit);   // git chip 后到：占锚位相邻（enhanceGitChip 的容忍规则）
  h.tick();
  const chip = h.chipOf(ui.row);
  assert.equal(chip.nextElementSibling, fakeGit, 'rate sits immediately before the git chip');
  assert.equal(ui.leadWrap.children.indexOf(ui.cua), 0, 'cua stays first');
  // 回退：无前导区（异形布局）→ 尾随区重置卡/额度组左侧（v146 原位）
  const fb = harness(), u1 = fb.buildComposer('workspace-main', 'sid_main', { leading: false });
  fb.inject(); fb.boot(); fb.tick();
  fb.window.__zusageUpdate(fb.payload({ tps: 87.3 }));
  const fchip = fb.chipOf(u1.row);
  assert.ok(fchip, 'fallback chip mounted');
  assert.equal(fchip.parentElement, u1.row, 'fallback host is the toolbar row');
  assert.equal(fchip.nextElementSibling, u1.wrap, 'fallback anchors left of the quota group wrapper');
});

test('no valid sample hides the chip (user decision); non-compact themes never mount it', () => {
  const none = harness(), u0 = none.buildComposer('workspace-main', 'sid_main');
  none.inject(); none.boot(); none.tick();
  none.window.__zusageUpdate(none.payload({}));
  none.tick();
  assert.equal(none.chipOf(u0.row), null, 'no tps -> no chip (settings entry gap accepted)');
  const def = harness({ theme: 'default' }), u1 = def.buildComposer('workspace-main', 'sid_main');
  def.inject(); def.boot(); def.tick();
  def.window.__zusageUpdate(def.payload({ tps: 87.3 }));
  def.tick();
  assert.equal(def.chipOf(u1.row), null, 'rate chip is compact-mode only');
});

test('content is signature-idempotent, re-anchors after being displaced, and updates on new data', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  let chip = h.chipOf(ui.row);
  chip.innerHTML += '<!--hover-state-->';
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  h.tick();
  assert.ok(chip.innerHTML.includes('<!--hover-state-->'), 'same signature leaves the DOM untouched');
  assert.equal(h.chipOf(ui.row), chip, 'no duplicate chip');
  // React 挤位：速率 chip 被挪到前导区末尾，heavy 对账兜回锚位（cua-entry 之后）
  const spacer = new Element('span');
  ui.leadWrap.insertBefore(spacer, ui.cua.nextElementSibling);   // [cua][spacer][...]
  ui.leadWrap.appendChild(chip);   // 挤到末尾
  h.tick();
  chip = h.chipOf(ui.row);
  assert.equal(chip.nextElementSibling, spacer, 'displaced chip is moved back right after the cua anchor');
  // 数据变化：签名变化重建内容
  h.window.__zusageUpdate(h.payload({ tps: 12.5 }));
  chip = h.chipOf(ui.row);
  assert.equal(chip.innerHTML, '<span class="zu-live hot"><span class="zu-sp-label"></span><span class="zu-sp-val">12.5</span><span class="zu-sp-unit dim">t/s</span></span>', 'new band class on new value');
});

test('tooltip: speed rows + bar summary gated by per-cell toggles + legend + settings button that opens the panel', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  const chip = h.chipOf(ui.row);
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl();
  assert.ok(tip && tip.style.display === 'block', 'tps tip shown');
  assert.ok(tip.innerHTML.includes('生成速度'), 'speed header');
  assert.ok(tip.innerHTML.includes('状态条摘要'), 'summary section');
  assert.ok(tip.innerHTML.includes('本轮'), 'turn summary row');
  assert.ok(tip.innerHTML.includes('会话累计'), 'session summary row');
  assert.ok(tip.innerHTML.includes('今日合计'), 'today summary row');
  assert.ok(tip.innerHTML.includes('颜色对照'), 'band legend');
  assert.ok(tip.innerHTML.includes('打开设置'), 'settings entry button');
  assert.ok(tip.innerHTML.includes('子代理'), 'sub-agent row');
  // v159 项目累计摘要行：无 project 字段不出现，有字段才出现（含子代理口径）
  assert.ok(!tip.innerHTML.includes('项目累计'), 'no project summary row without project data');
  h.window.__zusageUpdate(h.payload({ tps: 87.3, project: { sessions: 3, requests: 45, total: 6700 } }));
  chip.listeners.get('mouseleave')[0].call(chip);   // v155 悬停冻结：需真正收起（延迟收起窗口过后的重进）才按新签名重建
  chip.listeners.get('blur')[0].call(chip);         // blur 走立即隐藏路径
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.ok(tip.innerHTML.includes('项目累计'), 'project summary row with snapshot field');
  assert.ok(tip.innerHTML.includes('3会话 · 45次'), 'project row shows sessions and requests');
  // 逐格开关继续生效（用户拍板）：关掉「本轮」后摘要行消失
  h.window.tpsTest.state().show.turn = 0;
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  chip.listeners.get('mouseleave')[0].call(chip);   // v155 悬停冻结：需真正收起（延迟收起窗口过后的重进）才按新签名重建
  chip.listeners.get('blur')[0].call(chip);         // blur 走立即隐藏路径
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.ok(!tip.innerHTML.includes('本轮'), 'turn row disappears with the cell toggle');
  // 关掉「项目累计」后摘要行同样消失
  h.window.tpsTest.state().show.proj = 0;
  h.window.__zusageUpdate(h.payload({ tps: 87.3, project: { sessions: 3, requests: 45, total: 6700 } }));
  chip.listeners.get('mouseleave')[0].call(chip);
  chip.listeners.get('blur')[0].call(chip);
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.ok(!tip.innerHTML.includes('项目累计'), 'project row disappears with the cell toggle');
  // 「打开设置」按钮：走 chip.__zuOpen 开设置面板
  const bar = h.barEl();
  const gear = bar.querySelector('.zu-gear');
  chip.listeners.get('mouseleave')[0].call(chip);   // 模拟移入 tooltip 前的桥（延迟收起）
  chip.listeners.get('mouseenter')[0].call(chip);
  const btnFake = { closest: sel => (sel === '.tps-cfg' ? { __isCfg: true } : null) };
  tip.listeners.get('click')[0]({ target: btnFake, stopPropagation() {} });
  const panel = h.panelEl();
  assert.ok(panel && panel.classList.contains('open'), 'settings panel opened from the tooltip');
  assert.equal(gear.getAttribute('aria-expanded'), 'true');
  // 子代理摘要行点击开统一浮层（v217：__zuOpenSub → subPopShow pinned）
  const subFake = { closest: sel => (sel === '.tps-subrow' ? { __isSub: true } : null) };
  chip.listeners.get('mouseenter')[0].call(chip);
  tip.listeners.get('click')[0]({ target: subFake, stopPropagation() {} });
  const subp = h.body.children.find(e => e.classList.contains('zu-sub-pop'));
  assert.ok(subp && subp.classList.contains('open'), 'unified sub popover opened from the tooltip row');
  // 右键 chip 直开设置（用户规格 2026-11-09）：镜像 .tps-cfg 路径——先收 tooltip 再开面板
  panel.classList.remove('open'); gear.setAttribute('aria-expanded', 'false');   // 复位上一用例打开的面板
  chip.listeners.get('mouseleave')[0].call(chip);
  chip.listeners.get('blur')[0].call(chip);
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.equal(tip.style.display, 'block', 'tooltip visible before right-click');
  let ctxPrevented = false;
  chip.listeners.get('contextmenu')[0]({ preventDefault() { ctxPrevented = true; } });
  assert.ok(ctxPrevented, 'native context menu suppressed');
  assert.equal(tip.style.display, 'none', 'tooltip hidden on chip right-click');
  assert.ok(panel.classList.contains('open'), 'settings panel opened by chip right-click');
  assert.equal(gear.getAttribute('aria-expanded'), 'true');
});

const src04Gear = () => /var SPD3_SVG_GEAR = '([^']*)'/.exec(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', '04-speed-v3-view.js'), 'utf8'))[1];
// v468（issue #474）：带轮表时精简速率 chip 的悬停卡是速度整卡（spd3RebuildOr 闭包产物），
// 此前「打开设置」只在无轮表的回退卡里——正常用过一轮后整卡里没有任何设置入口。锁定：整卡标题后
// 带 .tps-cfg 且点击开面板；按钮只由精简 chip 这条调用链传 cfgBtn（条面速度卡不传、纯装配层测试另锁）。
test('v468: 带轮表的速度整卡带「打开设置」并打开面板（精简速率 chip，issue #474）', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const now = Date.now(), HOUR = 3600000;
  const row = (i, at, out, ms) => ({ s: 0, t: at, b: at - 60000, out, ms, i: 2000, o: out, n: 1, msl: [[0, out, 2000, 1]] });
  const p = h.payload({ tps: 97.1 });
  p.speed_history = { sid: 'sid_main', source: 'local', truncated: false, sids: ['sid_main'], snames: ['本会话'],
    pids: [['proj_a', '项目A']], mnames: ['GLM-A'], mkeys: ['prov_a\u001fglm-a'],
    turns: [row(0, now - 2 * HOUR, 600, 6000), row(1, now - HOUR, 400, 4000)] };
  h.window.__zusageUpdate(p);
  const chip = h.chipOf(ui.row);
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl();
  assert.ok(tip.innerHTML.includes('class="zu-sv3-root"'), '带轮表 → 速度整卡（不是回退卡）');
  assert.ok(!tip.innerHTML.includes('状态条摘要'), '整卡不含旧摘要区（报告者所述事实）');
  const open = tip.innerHTML.indexOf('class="zu-sv-title"'), close = tip.innerHTML.indexOf('class="zu-sv-filter"');
  assert.ok(open >= 0 && close > open, '标题行在前、筛选组在后');
  const head = tip.innerHTML.slice(open, close);
  assert.ok(head.includes('class="tps-cfg zu-sv-cfg" aria-label="打开设置"') && head.includes('aria-haspopup="dialog"'), '标题行内是带无障碍名称的设置图标按钮');
  assert.ok(head.includes('title="打开设置"'), '图标按钮带悬停提示');
  assert.ok(head.includes('<circle cx="12" cy="12" r="3.5"/></svg>'), '按钮内容是齿轮图标');
  const cfgOpen = head.lastIndexOf('<button', head.indexOf('class="tps-cfg zu-sv-cfg"'));
  assert.equal(cfgOpen >= 0 && head.slice(cfgOpen, head.indexOf('</button>', cfgOpen)).replace(/<[^>]+>/g, ''), '', '按钮不带「打开设置」文字（v468：图标同状态条齿轮）');
  // 图标与状态条 ⚙ 同款：04 分片 SPD3_SVG_GEAR 与 06 分片 .zu-gear 的 SVG 串逐字一致
  const src06 = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', '06-instance-dom-and-styles.js'), 'utf8');
  // 06 分片里这枚 SVG 跨两行字符串拼接，按「开头标签」与「path…</svg>」两段分别比对
  const part = (s, from, to) => { const i = s.indexOf(from); return i < 0 ? null : s.slice(i, s.indexOf(to, i) + to.length); };
  const g06 = src06.indexOf('class="btn zu-gear"'), tail06 = src06.slice(g06);
  assert.ok(g06 >= 0, '找到 06 分片的齿轮按钮');
  assert.equal(part(tail06, '<svg viewBox="0 0 24 24"', 'aria-hidden="true">'), part(src04Gear(), '<svg viewBox="0 0 24 24"', 'aria-hidden="true">'), '开头标签同款');
  assert.equal(part(tail06, '<path d="M9.5 2h5', '</svg>'), part(src04Gear(), '<path d="M9.5 2h5', '</svg>'), '齿轮路径同款');
  assert.equal(tip.innerHTML.split('tps-cfg zu-sv-cfg').length - 1, 1, '整卡只有一枚设置按钮');
  const bar = h.barEl(), gear = bar.querySelector('.zu-gear');
  const onCfg = { closest: sel => (sel === '.tps-cfg' ? {} : null) }, noOp = () => {};
  /* 只走 click、不走 pointerdown（v468 实机教训）：pointerdown 开面板后，同一次按压的 mousedown 会被
   * 文档级「点面板外即关」当成面板外按压，面板开了又被关——实机追踪 panel.open=true → 1ms 后 false。 */
  tip.listeners.get('click')[0]({ target: onCfg, stopPropagation: noOp });
  assert.equal(tip.style.display, 'none', '点击后收起悬停卡');
  const panel = h.panelEl();
  assert.ok(panel && panel.classList.contains('open'), '设置面板从整卡打开');
  assert.equal(gear.getAttribute('aria-expanded'), 'true');
  // 源码锁：cfgBtn 只在精简速率 chip 的调用点传入
  // 扫全部分片：默认/药丸速度卡的调用点在 07 分片（review 抓回——只读 11 分片的锁挡不住它们带上 cfgBtn）
  const dir = path.join(__dirname, '..', 'src', 'overlay');
  const hits = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
    .map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8').split('cfgBtn: true').length - 1]).filter(([, n]) => n > 0);
  assert.deepEqual(hits, [['11-instance-toolbar-chips.js', 1]], 'cfgBtn 只在精简速率 chip 的调用点传入（扫全部分片）');
});

// v468（issue #474 跟进）：用户先点 chip（焦点落 chip）再点卡里的齿轮——mousedown 移走焦点，chip 的 blur
// 若在此时收卡，click 就落到页面内容上。锁定：指针停在卡上时失焦不收、随后点齿轮开面板；指针不在卡上
// （键盘 Tab 离开）时失焦照旧收卡。
test('v468: chip focused by a click → blur while the pointer is over the speed card does not hide it; gear click then opens the panel', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  const chip = h.chipOf(ui.row), tip = h.tipEl();
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.equal(tip.style.display, 'block', 'tip shown');
  // 指针停在卡上（真实浏览器里 tpsTip.matches(':hover') 为 true）
  tip.matches = sel => sel === ':hover';
  chip.listeners.get('blur')[0].call(chip, { relatedTarget: null });
  assert.equal(tip.style.display, 'block', 'blur with the pointer over the card keeps it open');
  const gear = h.barEl().querySelector('.zu-gear');
  tip.listeners.get('click')[0]({ target: { closest: sel => (sel === '.tps-cfg' ? {} : null) }, stopPropagation() {} });
  assert.equal(tip.style.display, 'none', 'gear click hides the card');
  assert.ok(h.panelEl().classList.contains('open'), 'gear click opens the settings panel');
  assert.equal(gear.getAttribute('aria-expanded'), 'true');
  // 对照：指针不在卡上（键盘路径）——失焦照旧收卡
  tip.matches = () => false;
  chip.listeners.get('mouseenter')[0].call(chip);
  assert.equal(tip.style.display, 'block', 'tip shown again');
  chip.listeners.get('blur')[0].call(chip, { relatedTarget: null });
  assert.equal(tip.style.display, 'none', 'blur away from the card still hides it (keyboard path)');
});

test('dispose removes the chip; switching theme to default via setBarTheme removes it too', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload({ tps: 87.3 }));
  const chip = h.chipOf(ui.row);
  assert.ok(chip, 'chip mounted');
  h.window.tpsTest.setBarTheme('default');
  assert.equal(h.chipOf(ui.row), null, 'leaving compact removes the rate chip immediately');
  h.window.tpsTest.setBarTheme('compact');
  h.tick();
  const again = h.chipOf(ui.row);
  assert.ok(again && again !== undefined, 're-entering compact re-mounts');
  h.window.tpsTest.instances()[0].dispose();
  assert.equal(h.chipOf(ui.row), null, 'dispose cleans up the chip');
});

// v181 补修锁定：会话均下 chip 面文本与 tooltip 的 dbTps 门；v222 起「时间范围」行
// 反转为会话均下展示（会话累计口径，与会话累计 tooltip 同源同款）。
// v228：chip 面去「· 近X」尾缀（用户规格）——最近一段只在 tooltip，dbTps 不再上 chip 面。
test('session avg + dbTps>0: chip 面=最后一轮真实值（v298 拍板）；tooltip 有「最近一段」与会话口径「时间范围」行', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const p = h.payload({ tps: 42 });
  p.recent[0].avg_tps = 85.5;
  p.recent[0].last.startedAt = 1000;
  p.recent[0].last.endedAt = 2000;
  const t0 = new Date(2026, 10, 3, 12, 0, 0).getTime(), t1 = new Date(2026, 10, 3, 12, 30, 0).getTime();
  p.recent[0].started = t0;
  p.recent[0].last_at = t1;   // 覆盖夹具的 last_at:1：会话范围行按真实时刻断言
  h.window.__zusageUpdate(p);
  const chip = h.chipOf(ui.row);
  assert.equal(chip.innerHTML, '<span class="zu-live warm"><span class="zu-sp-label"></span><span class="zu-sp-val">42</span><span class="zu-sp-unit dim">t/s</span></span>');   // v298：面=最后一轮，去「均」前缀；档位色按面上数字（42∈40–70 warm），不再取会话均的档（稳定占位：数值与颜色同一快照）
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl().innerHTML;
  assert.ok(tip.includes('zu-stat-scope">会话平均<'), 'session-avg scope tag');
  assert.ok(tip.includes('最近一段') && /42 <small>t\/s<\/small>/.test(tip), 'latest-segment row when dbTps>0');
  assert.ok(tip.includes('时间范围'), 'time span row present under session-avg (v222)');
  assert.ok(tip.includes('2026-11-03 12:00:00 — 2026-11-03 12:30:00'), 'session range = session window, not the last segment');
  assert.ok(!tip.includes('1970-'), 'segment range (epoch 1000/2000) must not leak into session-avg span');
});

test('session avg + dbTps=0: chip 面空（v298 无最后一轮不显会话均）；tooltip 无「最近一段」；会话起点缺失时无「时间范围」行', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const p = h.payload({});              // last.tps 缺席 → dbTps 0；started 缺席 → 无时间范围行
  p.recent[0].avg_tps = 85.5;
  h.window.__zusageUpdate(p);
  const chip = h.chipOf(ui.row);
  assert.equal(chip.innerHTML, '<span class="zu-live dim"></span>');   // v298：无最后一轮真实值=面留空（无数值不带档位色）
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl().innerHTML;
  assert.ok(!tip.includes('最近一段'), 'no latest-segment row without dbTps');
  assert.ok(!tip.includes('时间范围'), 'no time-span row without a session start (half span suppressed)');
});

test('session avg + dbTps=0 + 会话起点在：无「最近一段」，「时间范围」行为会话口径（v222）', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const p = h.payload({});
  p.recent[0].avg_tps = 85.5;
  p.recent[0].started = new Date(2026, 10, 3, 8, 5, 0).getTime();
  p.recent[0].last_at = new Date(2026, 10, 3, 9, 6, 0).getTime();
  h.window.__zusageUpdate(p);
  const chip = h.chipOf(ui.row);
  chip.listeners.get('mouseenter')[0].call(chip);
  const tip = h.tipEl().innerHTML;
  assert.ok(!tip.includes('最近一段'), 'no latest-segment row without dbTps');
  assert.ok(tip.includes('2026-11-03 08:05:00 — 2026-11-03 09:06:00'), 'session span renders independently of dbTps');
});
