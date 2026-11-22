const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v383 Git chip 工具栏四级响应式（specs/git-chip-responsive.md）：
 * 候选生成/风险优先/⋯折叠语义/选级迟滞/hidden 回展/宿主 compact 封顶/反自指测量/fail-safe。
 * 夹具沿用 overlay-git-chip.test.cjs 的整 IIFE + instances/state 接缝模式。 */
let chipRectFn = null;   // v383：.zu-git 系元素宽度解析器（按 className 调用时求值；覆盖 chip/重建 chip/探针）
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
    this.style.setProperty = (k, v) => { this.style[k] = v; };
    this.style.getPropertyValue = k => this.style[k] || '';
    this.listeners = new Map(); this.queries = new Map(); this.classes = new Set();
    this.classList = { contains: k => this.classes.has(k), add: k => this.classes.add(k), remove: k => this.classes.delete(k),
      toggle: (k, on) => { if (on) this.classes.add(k); else this.classes.delete(k); } };
    this.textContent = ''; this.innerHTML = ''; this._className = ''; this.isConnected = true;
    this.offsetWidth = 200; this.offsetHeight = 80;
  }
  // 真实 DOM 语义：className 赋值与 classList 同步（增强逻辑/断言都依赖 contains 能看到脚本写入的类）
  set className(v) { this._className = String(v); this.classes.clear(); this._className.split(/\s+/).filter(Boolean).forEach(c => this.classes.add(c)); }
  get className() { return this._className; }
  get nextSibling() {
    const p = this.parentElement;
    if (!p) return null;
    return p.children[p.children.indexOf(this) + 1] || null;
  }
  setAttribute(k, v) { this.dataset[k] = String(v); }
  removeAttribute(k) { delete this.dataset[k]; }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  get nextElementSibling() { return this.nextSibling; }
  get lastElementChild() { return this.children.at(-1) || null; }
  setConnected(value) { this.isConnected = value; this.children.forEach(el => el.setConnected(value)); }
  appendChild(el) { if (el.parentElement) el.remove(); this.children.push(el); el.parentElement = this; el.setConnected(this.isConnected); return el; }
  insertBefore(el, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    if (el === ref) return el;
    if (el.parentElement) el.remove();
    this.children.splice(this.children.indexOf(ref), 0, el); el.parentElement = this; el.setConnected(this.isConnected); return el;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.parentElement = null; this.setConnected(false); }
  cloneNode() {   // v383：离屏测量探针克隆（gitMeasureWidth 消费；className 会被探针覆写为候选等级类）
    const p = new Element(this.tagName.toLowerCase());
    p.className = this._className;
    return p;
  }
  querySelector(k) {
    if (k === '.zu-sr-only') return this.querySelectorAll(k)[0] || null;
    for (const testid of ['chat-context-usage-trigger', 'v4-composer-cua-entry', 'chat-mode-select-trigger', 'chat-thought-level-select-trigger']) {
      if (k === `[data-testid="${testid}"]`) {
        for (const c of this.children) {
          if (c.dataset && c.dataset['data-testid'] === testid) return c;
          const hit = c.querySelector && c.querySelector(k);
          if (hit) return hit;
        }
        return null;
      }
    }
    // 与 lifecycle 夹具同语义：未预注册的选择器返回可写的空元素，面板构建等假设节点存在
    if (!this.queries.has(k)) this.queries.set(k, new Element());
    return this.queries.get(k);
  }
  matches(sel) { return sel === '.zu-sr-only' ? this.classList.contains(sel.slice(1)) : false; }
  querySelectorAll(sel) {
    if (/^\[data-composer-[a-z-]+\]$/.test(sel)) return this.children.flatMap(e => [ ...(e.hasAttribute(sel.slice(1, -1)) ? [e] : []), ...e.querySelectorAll(sel) ]);
    if (/^\[data-testid="[^"]+"\]$/.test(sel)) {
      const testid = sel.slice(14, -2);
      return this.children.flatMap(e => [ ...(e.getAttribute('data-testid') === testid ? [e] : []), ...e.querySelectorAll(sel) ]);
    }
    if (sel === 'circle') return this.children.filter(e => e.tagName === 'CIRCLE').concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    if (sel === '.zu-sr-only') return this.children.flatMap(e => [ ...(e.matches && e.matches(sel) ? [e] : []), ...(e.querySelectorAll ? e.querySelectorAll(sel) : []) ]);
    return [];
  }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return k === 'data-pane-id' ? !!this.pid : k === 'data-session-id' ? !!this.sid : Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return k === 'data-pane-id' ? (this.pid || null) : k === 'data-session-id' ? (this.sid || null) : (this.dataset[k] !== undefined ? this.dataset[k] : null); }
  getBoundingClientRect() {
    if (chipRectFn) { const w = chipRectFn(this); if (w != null) return { top: 600, bottom: 628, left: 20, right: 20 + w, width: w, height: 28 }; }
    for (let p = this; p; p = p.parentElement) {
      if (p.style.display === 'none') return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    }
    return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 };
  }
}

function harness() {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(); let id = 0;
  /* v308：受控时钟（默认零偏移=真实时间）。ghostOf 的 120ms TTL 用 Date.now 计费，
   * 「同元素先 live 后 hidden」的同步序列须 advance 越过 TTL 才能观察到新判定。 */
  let clockOffset = 0;
  class ZuDate extends Date { }
  ZuDate.now = () => Date.now() + clockOffset;
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    Date: ZuDate,
    location: { href: 'file:///fixture' }, localStorage: { getItem: k => (k === 'zusage3.tipHoverMs' ? '0' : null), setItem() {} },   // v440：门槛关直通（本文件测开门后行为；门槛链由 overlay-tip-activation 锁）
    getComputedStyle: el => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible', ...el.style }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.gitTest = { instances: function() { return instances; }, state: function() { return state; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function buildComposer(pid, sid, { repoPath = '/repo/a', identity = '', remote = '' } = {}) {
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
    const value = svg.appendChild(new Element('circle'));
    const cua = row.appendChild(new Element('button'));
    cua.setAttribute('data-testid', 'v4-composer-cua-entry');
    cua.setAttribute('aria-label', '电脑操作');
    cua.appendChild(new Element('span'));   // 原生标签 span（紧凑态隐藏的对象）
    const editor = card.appendChild(new Element('textarea'));
    editor.pid = pid; editor.sid = sid;
    // SessionPane scope 属性挂在 pane 祖先链节点上（renderer_bridge.py 写入的真实位置）
    editor.setAttribute('data-zusage-scope-version', '1');
    editor.setAttribute('data-zusage-pane-id', pid);
    editor.setAttribute('data-zusage-workspace-path', repoPath);
    editor.setAttribute('data-zusage-workspace-identity', identity);
    editor.setAttribute('data-zusage-remote-session-id', remote);
    panes.push(editor);
    return { card, row, wrap, btn, svg, value, cua, editor };
  }
  function payload({ ctx = 63400, cw = 200000 } = {}) {
    return { remote_evidence: false, today: {}, not_local: [],
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx, context_window: cw, last_at: 1 }] };
  }
  function advance(ms) { clockOffset += ms; }   // v308：时钟快进（越过 TTL 缓存）
  return { window, body, inject, tick, boot, advance, buildComposer, payload, setChipRect: fn => { chipRectFn = fn; } };
}

function gitState(o = {}) {
  return Object.assign({ ok: true, branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1,
    detached: false, noCommits: false, staged: 3, unstaged: 2, untracked: 1, conflicts: 0,
    ins: 1328, del: 223, ts: 1730000000000 }, o);
}
function chipOf(row) {
  return row.children.find(e => e.classList && e.classList.contains('zu-git')) || null;
}
function dispatch(el, type, ev = {}) {
  for (const fn of el.listeners.get(type) || []) fn.call(el, Object.assign({ preventDefault() {}, stopPropagation() {} }, ev));
}
function drive(h, ui, st = gitState()) {
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  if (st !== null) h.window.__zusageGitState('/repo/a', st);
  return chipOf(ui.row);
}

/* 前导区结构夹具：content/available/trailing 注册进 row 查询缓存（与真实宿主 data-composer-* 同名）。 */
function leadingFixture(h, ui, { contentW = 250, budget = 300, trailW = 100, rowW = 600, gap = 12 } = {}) {
  const content = new Element(), available = new Element(), trailing = new Element();
  content.setAttribute('data-composer-leading-content', '');
  available.setAttribute('data-composer-leading-actions', '');
  trailing.setAttribute('data-composer-trailing-actions', '');
  content.getBoundingClientRect = () => ({ width: contentW, height: 28 });
  available.getBoundingClientRect = () => ({ width: budget, height: 28 });
  trailing.getBoundingClientRect = () => ({ width: trailW, height: 28 });
  ui.row.getBoundingClientRect = () => ({ width: rowW, height: 28 });
  ui.row.clientWidth = rowW;
  ui.row.queries.set('[data-composer-leading-content]', content);
  ui.row.queries.set('[data-composer-leading-actions]', available);
  ui.row.queries.set('[data-composer-trailing-actions]', trailing);
  return { content, available, trailing };  // gap 由沙箱 getComputedStyle 的 columnGap 缺省 NaN||0 吸收
}

/* ---------- 纯函数：候选生成 ---------- */
function fns(h) { return h.window.__zusageGitFns.all(); }

test('candidates: L2 keeps risks (short !N, op, stale) and the work segment, folds branch into ⋯', () => {
  const h = harness(), ui0 = h.buildComposer('workspace-main', 'sid_main');
  drive(h, ui0);
  const view = { st: gitState({ conflicts: 2, op: 'rebase' }), stale: false };
  const c = fns(h).gitCandidates(view);
  assert.equal(c.L0, c.L1, 'L1 复用 L0 串（紧凑靠 zu-compact CSS）');
  assert.match(c.L2, /zu-git-conflict">!2</);
  assert.match(c.L2, /zu-git-ins">\+1328</);
  assert.match(c.L2, /zu-git-del">-223</);
  assert.match(c.L2, /zu-git-op">变基</);
  assert.match(c.L2, /zu-git-more">⋯</, '?N 被行数段折叠 → ⋯');
  assert.doesNotMatch(c.L2, /zu-git-name/, '分支名被工作段取代');
  assert.doesNotMatch(c.L2, /\(/, '摘要不带括号段');
  assert.match(c.L3, /zu-git-dot-r/);
  assert.match(c.L3, /zu-git-conflict">!2</, 'L3 冲突短标保留');
  assert.doesNotMatch(c.L3, /zu-git-op|zu-git-ins/, 'L3 不带操作词与行数');
  assert.match(c.L3I, /zu-git-dot-r/);
  assert.ok(!/<button/.test(c.L2 + c.L3 + c.L3I), '⋯/状态点不是交互目标');
});

test('candidates: single-metric adaptation — only untracked / clean / detached / init', () => {
  const h = harness(), ui0 = h.buildComposer('workspace-main', 'sid_main');
  drive(h, ui0);
  const onlyUnt = fns(h).gitCandidates({ st: gitState({ ins: 0, del: 0, upstream: '', ahead: 0, behind: 0, untracked: 4 }), stale: false });
  assert.match(onlyUnt.L2, /zu-git-unt">\?4</);
  assert.doesNotMatch(onlyUnt.L2, /zu-git-more/, '任务书示例：⎇ ?4 不加 ⋯（分支名收纳是 L2 预期行为）');
  const clean = fns(h).gitCandidates({ st: gitState({ ins: 0, del: 0, untracked: 0, upstream: '', ahead: 0, behind: 0, staged: 0, unstaged: 0 }), stale: false });
  assert.match(clean.L2, /zu-git-name">main</, '无改动时显示分支名');
  assert.doesNotMatch(clean.L2, /zu-git-more/);
  const det = fns(h).gitCandidates({ st: gitState({ detached: true, branch: '', ins: 0, del: 0, untracked: 0, upstream: '', ahead: 0, behind: 0 }), stale: false });
  assert.match(det.L2, /zu-git-name">HEAD</, '游离 HEAD 保持特殊语义');
  const init = fns(h).gitCandidates({ st: gitState({ noCommits: true, ins: 0, del: 0, untracked: 0, upstream: '', ahead: 0, behind: 0 }), stale: false });
  assert.match(init.L2, /初始/, '尚无首次提交显示初始状态');
});

test('candidates: upstream fold and stale badges; dot colors encode risk', () => {
  const h = harness(), ui0 = h.buildComposer('workspace-main', 'sid_main');
  drive(h, ui0);
  const cleanAb = fns(h).gitCandidates({ st: gitState({ ins: 0, del: 0, untracked: 0, ahead: 3, behind: 0 }), stale: false });
  assert.match(cleanAb.L2, /zu-git-name">main</);
  assert.match(cleanAb.L2, /zu-git-more/, '↑↓ 被收起 → ⋯');
  const stale = fns(h).gitCandidates({ st: gitState(), stale: true });
  assert.match(stale.L2, /zu-git-warn">过期</);
  assert.match(stale.L3, /zu-git-warn">过期</);
  assert.match(stale.L3I, /zu-git-dot-n/, '过期=未知态中性点');
  const dirty = fns(h).gitCandidates({ st: gitState({ conflicts: 0 }), stale: false });
  assert.match(dirty.L3I, /zu-git-dot-y/);
  const fresh = fns(h).gitCandidates({ st: gitState({ conflicts: 0, ins: 0, del: 0, untracked: 0, ahead: 0, behind: 0 }), stale: false });
  assert.match(fresh.L3I, /zu-git-dot-g/);
  /* review M1：rebase/merge 中 + 干净树，L3/L3I 不得呈现绿点（伪造干净态）——点色承载操作态 */
  const midop = fns(h).gitCandidates({ st: gitState({ conflicts: 0, ins: 0, del: 0, untracked: 0, ahead: 0, behind: 0, op: 'rebase' }), stale: false });
  assert.doesNotMatch(midop.L3I, /zu-git-dot-g/, '操作中不得显绿');
  assert.match(midop.L3I, /zu-git-dot-y/);
  assert.doesNotMatch(midop.L3, /zu-git-op/, 'L3 不带操作词（点色与 Tooltip 承载，既有契约）');
  const midopMulti = fns(h).gitCandidates({ st: { ok: true, kind: 'multi', failed: 0, ts: 1, repos: [{ path: '/r/a', changed: 0, untracked: 0, conflicts: 0, op: 'merge' }] }, stale: false });
  assert.match(midopMulti.L3I, /zu-git-dot-y/, '多仓操作中同样不得显绿');
});

test('candidates: multi summary keeps repo count + conflict + failed, folds 改 into ⋯', () => {
  const h = harness(), ui0 = h.buildComposer('workspace-main', 'sid_main');
  drive(h, ui0);
  const st = { ok: true, kind: 'multi', failed: 0, ts: 1, repos: [
    { path: '/r/a', changed: 2, untracked: 0, conflicts: 0 },
    { path: '/r/b', changed: 1, untracked: 1, conflicts: 3 },
    { path: '/r/c', err: 'timeout' },
  ] };
  const c = fns(h).gitCandidates({ st, stale: false });
  assert.match(c.L2, /zu-git-name">3仓</, '仓库数保留');
  assert.match(c.L2, /zu-git-conflict">!1</, '确认冲突仓数（stale 仓不计）');
  assert.match(c.L2, /zu-git-warn">1失败</, '失败仓保留文字');
  assert.match(c.L2, /zu-git-more/, 'M改 折叠 → ⋯');
  assert.doesNotMatch(c.L2, /zu-git-dirty/, '「改」计数段折叠');
  assert.match(c.L3, /zu-git-dot-r/);
  assert.match(c.L3, /!1/);
  const cleanMulti = fns(h).gitCandidates({ st: { ok: true, kind: 'multi', failed: 0, ts: 1, repos: [{ path: '/r/a', changed: 0, untracked: 0, conflicts: 0 }] }, stale: false });
  assert.doesNotMatch(cleanMulti.L2, /zu-git-more/, '无折叠信息不显 ⋯');
  assert.match(cleanMulti.L3I, /zu-git-dot-g/);
});

test('candidates: no fabricated totals (design-mock Git 928 is rejected)', () => {
  const h = harness(), ui0 = h.buildComposer('workspace-main', 'sid_main');
  drive(h, ui0);
  const c = fns(h).gitCandidates({ st: gitState({ ins: 764, del: 164 }), stale: false });
  for (const key of ['L2', 'L3', 'L3I']) {
    assert.doesNotMatch(c[key], /928/, '绝不拼接 ins+del 假汇总');
    assert.doesNotMatch(c[key], /600|601/, '绝不拼接 ins−del 假净差');
  }
});

/* ---------- 纯函数：选级（宿主 compact 封顶 / 迟滞 / hidden 回展） ---------- */
test('selection: host compact caps candidates at L1 even with ample space', () => {
  const h = harness(), ui0 = h.buildComposer('workspace-main', 'sid_main');
  drive(h, ui0);
  const pick = fns(h).pickQuotaDisplayLevel;
  const widths = { L0: 210, L1: 70, L2: 150, L3: 26, L3I: 24 };
  assert.equal(pick(['L1', 'L2', 'L3', 'L3I'], 1000, k => widths[k], 'L1', 20), 'L1', '宿主 compact 下永不展开全名');
  assert.equal(pick(fns(h).GIT_ORDER, 1000, k => widths[k], 'L1', 20), 'L0', '非 compact 充足空间回 L0');
});

test('selection: shrink immediate, expand with +20 hysteresis, hidden roundtrip gated', () => {
  const h = harness(), ui0 = h.buildComposer('workspace-main', 'sid_main');
  drive(h, ui0);
  const pick = fns(h).pickQuotaDisplayLevel;
  const widths = { L0: 210, L1: 70, L2: 150, L3: 26, L3I: 24 };
  assert.equal(pick(fns(h).GIT_ORDER, 209, k => widths[k], 'L0', 20), 'L1', 'avail 209 < 210：立即收缩（无迟滞）');
  assert.equal(pick(fns(h).GIT_ORDER, 229, k => widths[k], 'L1', 20), 'L1', '210+20−1=229：差 1px 不回展');
  assert.equal(pick(fns(h).GIT_ORDER, 230, k => widths[k], 'L1', 20), 'L0', '230：迟滞满足回展');
  assert.equal(pick(fns(h).GIT_ORDER, 10, k => widths[k], 'L3I', 20), 'hidden', '连最简都放不下 → hidden');
  assert.equal(pick(fns(h).GIT_ORDER, 43, k => widths[k], 'hidden', 20), 'hidden', 'hidden 回展需 need+hyst（防临界抖动）');
  assert.equal(pick(fns(h).GIT_ORDER, 44, k => widths[k], 'hidden', 20), 'L3I', '24+20=44：回最简档');
});

/* ---------- gitMeasureAvail：标定/legacy/反自指/fail-safe ---------- */
/* 宽度解析器：任何创建的 .zu-git 系元素（含 hidden 后重建的 chip 与 cloneNode 探针）按
 * className 求值——真实 DOM 里同候选串宽度恒定，这是宽度缓存键控的同一不变式。
 * 非 chip 元素返回 null 走默认矩形。 */
function makeGitWidthOf() {
  return el => {
    const cl = el && el.classList;
    if (!cl || !cl.contains('zu-git')) return null;
    if (cl.contains('zu-compact')) return 70;
    if (cl.contains('zu-l3')) return 40;
    if (cl.contains('zu-l3i')) return 30;
    if (cl.contains('zu-l2')) return 160;
    return 210;
  };
}

test('gitMeasureAvail: calibrated arithmetic and the anti-self-reference invariant', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const leading = ui.row.appendChild(new Element());
  leading.setAttribute('data-composer-leading-content', 'true');
  const modes = leading.appendChild(new Element());
  modes.appendChild(new Element('button')).setAttribute('data-testid', 'chat-mode-select-trigger');
  leading.appendChild(ui.cua);
  drive(h, ui);
  const chip = chipOf(leading);
  assert.ok(chip, 'chip 挂在 leading-content 内');
  const availEl = new Element(), trailing = new Element();
  availEl.setAttribute('data-composer-leading-actions', 'true');
  trailing.setAttribute('data-composer-trailing-actions', 'true');
  ui.row.queries.set('[data-composer-leading-actions]', availEl);
  ui.row.queries.set('[data-composer-trailing-actions]', trailing);
  ui.row.getBoundingClientRect = () => ({ width: 600, height: 28 });
  ui.row.clientWidth = 600;
  availEl.getBoundingClientRect = () => ({ width: 300, height: 28 });
  trailing.getBoundingClientRect = () => ({ width: 100, height: 28 });
  leading.getBoundingClientRect = () => ({ width: 250, height: 28 });
  h.setChipRect(makeGitWidthOf());
  const avail = fns(h).gitMeasureAvail({ wrap: leading, btn: ui.cua, after: ui.cua }, chip);
  assert.equal(avail, 260, 'min(300, 600−100−gap0) − (250 − 210[L0态chipW]) = 260');
  // 反自指：chip 摘除后真实 DOM 里 content 同步收窄（250−210=40），avail 不变——不会坍缩为 0
  leading.getBoundingClientRect = () => ({ width: 40, height: 28 });
  const availRemoved = fns(h).gitMeasureAvail({ wrap: leading, btn: ui.cua, after: ui.cua }, null);
  assert.equal(availRemoved, 260, '摘除态（content=40, chipW=0）与挂载态同一 avail：无自指黑洞');
});

test('gitMeasureAvail: legacy row (no leading-actions) returns null; instance keeps the old two-state, never hides', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  assert.equal(chip.parentElement, ui.row);
  ui.row.clientWidth = 200;   // 极窄行：未标定结构不得据此隐藏/降级
  ui.row.getBoundingClientRect = () => ({ width: 200, height: 28 });
  ui.row.children.forEach(el => {
    el.getBoundingClientRect = () => ({ width: el === ui.cua ? 230 : 0, height: 28 });
  });
  assert.equal(fns(h).gitMeasureAvail({ wrap: ui.row, btn: ui.cua, after: ui.cua }, chip), null, 'legacy 结构 → null（伪读数防线）');
  h.tick();
  const chip2 = chipOf(ui.row);
  assert.ok(chip2, '极窄未标定行：chip 保持挂载（fail-safe 绝不隐藏）');
  assert.equal(chip2.getAttribute('data-zusage-glevel'), 'L0', '未标定 + 宿主未 compact → 保持 L0');
  ui.cua.setAttribute('data-composer-compact', 'true'); h.tick();
  assert.ok(chipOf(ui.row).classList.contains('zu-compact'), '未标定结构沿用宿主 compact 强制 L1（旧机制）');
  ui.cua.setAttribute('data-composer-compact', 'false'); h.tick();
  assert.ok(!chipOf(ui.row).classList.contains('zu-compact'), '宿主解除后回完整态（旧两态）');
});

test('gitMeasureAvail: uncalibrated structures fail safe to null (no guessed shrink)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  leadingFixture(h, ui, { contentW: 250, budget: 0.5, trailW: 100, rowW: 600 });
  assert.equal(fns(h).gitMeasureAvail({ wrap: ui.row, btn: ui.cua, after: ui.cua }, chip), null, 'leadA ≤1px（内容自撑行）→ null');
  const bad = new Element();
  bad.getBoundingClientRect = () => { throw new Error('no layout'); };
  assert.equal(fns(h).gitMeasureAvail({ wrap: bad, btn: ui.cua, after: ui.cua }, chip), null, 'rect 抛错 → null');
  assert.equal(fns(h).gitMeasureAvail(null, chip), null, 'mount 缺失 → null');
});

/* ---------- DOM 行为：降级/回展/hidden/宿主 compact 封顶/busy 保留/aria 全量 ---------- */
function levelFixture(h, ui, chip) {
  const { leading } = (() => {
    const leading = ui.row.appendChild(new Element());
    leading.setAttribute('data-composer-leading-content', 'true');
    const modes = leading.appendChild(new Element());
    modes.appendChild(new Element('button')).setAttribute('data-testid', 'chat-mode-select-trigger');
    leading.appendChild(ui.cua);
    return { leading };
  })();
  const env = leadingFixture(h, ui, { contentW: 0, budget: 1000, trailW: 0, rowW: 1200 });
  h.setChipRect(makeGitWidthOf());
  /* 自消不变式（真实 DOM 属性）：content.width = 原生控件(200) + chip 当前宽 —— chip 变级时
   * used=content−chipW 恒为 200，avail 与等级无关；stub 必须同构，否则每拍 seesaw（夹具伪影）。 */
  const widthOf = makeGitWidthOf();
  leading.getBoundingClientRect = () => {
    const cur = chipOf(leading);   // hidden 重建后 chip 换代：以当前在位 chip 求宽，摘除态 = 纯原生宽
    return { width: 200 + (cur ? (widthOf(cur) || 0) : 0), height: 28 };
  };
  env.setBudget = v => { env.available.getBoundingClientRect = () => ({ width: v, height: 28 }); return v; };
  return { leading, env };
}

test('DOM: progressive downgrade under shrinking budget, restore on widening, hidden removes node', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  const { leading, env } = levelFixture(h, ui, chip);
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L0', '宽裕空间保持完整态');
  env.setBudget(240); h.tick();   // avail = 240−200 = 40：L1(70)/L2(160) 不够，L3(40) 恰好可容
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L3', '跳过中间档直接选能容下的最完整档');
  assert.doesNotMatch(chip.innerHTML, /zu-git-name/, '最小形态不带分支名');
  env.setBudget(200); h.tick();   // avail = 0：连最简都放不下 → 摘除
  assert.equal(chipOf(leading), null, 'hidden 摘除节点');
  env.setBudget(250); h.tick();   // avail = 50：L3I 需 30+20=50 恰好回展（L3 需 60 仍不够）
  const back = chipOf(leading);
  assert.ok(back, '恢复宽度重现 chip');
  assert.equal(back.getAttribute('data-zusage-glevel'), 'L3I');
  env.setBudget(1000); h.tick();
  const full = chipOf(leading);
  assert.equal(full.getAttribute('data-zusage-glevel'), 'L0', '宽度恢复回完整态');
  assert.match(full.innerHTML, /zu-git-name/);
  h.advance(160); h.tick();
  assert.equal(chipOf(leading), full, '节点身份保持稳定');
});

test('DOM: hysteresis gates the L0 expansion at the exact boundary', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  const { env } = levelFixture(h, ui, chip);
  env.setBudget(405); h.tick();   // avail = 205 < 210：完整态放不下 → 立即收缩（收缩无迟滞）
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L1');
  assert.ok(chip.classList.contains('zu-compact'));
  env.setBudget(429); h.tick();   // avail = 229 < 210+20=230：差 1px 不回展
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L1', '229 < 230 迟滞不满足');
  env.setBudget(430); h.tick();   // avail = 230：迟滞满足回展
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L0');
  env.setBudget(405); h.tick();   // 再次收缩即时生效
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L1');
  env.setBudget(1000); h.tick();
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L0');
});

test('DOM: host compact caps at L1 regardless of budget; busy survives a level switch', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  const { leading, env } = levelFixture(h, ui, chip);
  ui.cua.setAttribute('data-composer-compact', 'true');
  env.setBudget(1000); h.tick();
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L1', '宿主 compact 封顶：充足空间也不展开全名');
  assert.ok(chip.classList.contains('zu-compact'));
  ui.cua.setAttribute('data-composer-compact', 'false');
  h.tick();
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L0', '宿主解除后按宽度回展');
  // busy 跨等级保留：点击刷新进入 gbusy，再压窄触发真实等级切换（L0→L3I，非 hidden 摘除）
  dispatch(chip, 'click');
  assert.ok(chip.classList.contains('zu-gbusy'));
  env.setBudget(250); h.tick();   // avail = 250−200 = 50：L0(210) 不容 → L3(40) 容（收缩即时，无迟滞）
  assert.equal(chip.getAttribute('data-zusage-glevel'), 'L3', '触发真实降级（非 hidden）');
  assert.equal(chipOf(leading), chip, '节点保持挂载（busy 断言不落在死节点上）');
  assert.ok(chip.classList.contains('zu-gbusy'), '等级切换不丢刷新忙态');
  assert.equal(chip.getAttribute('aria-busy'), 'true');
});

test('DOM: aria stays full at every level; tooltip data untouched', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  const { leading, env } = levelFixture(h, ui, chip);
  const aria0 = chip.getAttribute('aria-label');
  assert.match(aria0, /领先 2/);
  assert.ok(chip.__zuGit && chip.__zuGit.st.ins === 1328, '__zuGit 完整数据保留');
  env.setBudget(200); h.tick();   // hidden 摘除
  assert.equal(chipOf(leading), null);
  env.setBudget(250); h.tick();   // 回展重建（新节点；avail 50 → L3）
  const back = chipOf(leading);
  assert.ok(back && back !== chip, '回展为重建节点');
  const aria1 = back.getAttribute('aria-label');
  assert.equal(aria1, aria0, '低级别（L3 重建态）aria 与完整态一致（不裁剪）');
  assert.match(aria1, /未跟踪 1/);
});

test('CSS: summary/minimal level rules shipped (dot palette, more marker, no fake totals)', () => {
  assert.match(source, /\.zu-git \.zu-git-more\{opacity:\.55;margin:0 1px\}/);
  assert.match(source, /\.zu-git \.zu-git-dot\{width:6px;height:6px;border-radius:50%;flex:0 0 auto;margin:0 1px\}/);
  assert.match(source, /\.zu-git \.zu-git-dot-r\{background:#f09696\}/);
  assert.match(source, /\.zu-git \.zu-git-dot-g\{background:#aae6aa\}/);
  assert.match(source, /\.zu-git \.zu-git-dot-n\{background:#8b8e96\}/);
  assert.match(source, /\.zu-git\[data-zusage-light\] \.zu-git-dot-y\{background:#df8e1d\}/);
});

test('seam: __zusageGitFns exposes pure fns and is cleaned up on dispose', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  drive(h, ui);
  const seam = h.window.__zusageGitFns;
  assert.ok(seam && typeof seam.all === 'function');
  const all = seam.all();
  assert.equal(typeof all.gitCandidates, 'function');
  assert.equal(typeof all.gitMeasureAvail, 'function');
  assert.equal(all.GIT_ORDER.join(','), 'L0,L1,L2,L3,L3I');
  assert.equal(all.GIT_HYST, 20);
  h.window.gitTest.instances()[0].dispose();
  assert.equal(h.window.__zusageGitFns, undefined, 'dispose 按实例令牌清理缝');
});
