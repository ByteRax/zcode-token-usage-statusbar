const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v96 Git 多仓库聚合回归（tooltip 结构化重构后）：夹具与 overlay-git-chip.test.cjs 同款。
 * 覆盖：chip 语义段（份数/已知·上次前缀/!冲突/失败/过期文字徽章，·分隔）、聚合口径
 * （失败携带旧快照计入已知、旧冲突不算已确认）、紧凑/英文/幂等/dispose、tooltip 概览行
 * （有改动仓库数、非零冲突操作失败、条目汇总、覆盖率）、逐仓优先级排序与干净组分隔行、
 * 行内语义色类、失败行原因与过期标注、en 文案、样式（含浅色档与无 opacity 降透明）。 */
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
    this.style.setProperty = (k, v) => { this.style[k] = v; };
    this.style.getPropertyValue = k => this.style[k] || '';
    this.listeners = new Map(); this.queries = new Map(); this.classes = new Set();
    this.classList = { contains: k => this.classes.has(k), add: k => this.classes.add(k), remove: k => this.classes.delete(k),
      toggle: (k, on) => { if (on) this.classes.add(k); else this.classes.delete(k); } };
    this.textContent = ''; this.innerHTML = ''; this._className = ''; this.isConnected = true;
    this.offsetWidth = 200; this.offsetHeight = 80; this.scrollTop = 0;
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
  appendChild(el) { this.children.push(el); el.parentElement = this; return el; }
  insertBefore(el, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    const idx = this.children.indexOf(ref);
    if (el.parentElement) el.remove();
    this.children.splice(idx, 0, el); el.parentElement = this; return el;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.isConnected = false; }
  querySelector(k) {
    for (const testid of ['chat-context-usage-trigger', 'v4-composer-cua-entry']) {
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
  return { window, body, inject, tick, boot, buildComposer, payload };
}

function gitState(o = {}) {
  return Object.assign({ ok: true, branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1,
    detached: false, noCommits: false, staged: 3, unstaged: 2, untracked: 1, conflicts: 0,
    changed: 0, ins: 1328, del: 223, ts: 1730000000000 }, o);
}
/* 多仓成功仓条目 = parseGitPorcelain 输出 + name/path/ts/op（多仓管线不跑 diff 行数，无 ins/del/repoPath）；
 * 失败仓：最新失败仅有 name/path/err/tsAttempt；携旧快照的失败再加 stale:true 与上次字段 */
function repoEntry(name, o = {}) {
  return Object.assign({ name: name, path: '/w/' + name, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0, detached: false, noCommits: false, staged: 0, unstaged: 0,
    untracked: 0, conflicts: 0, changed: 0, op: '', ts: 1730000000000 }, o);
}
function multiState(o = {}) {
  return Object.assign({ ok: true, kind: 'multi', ts: 1730000000000, more: 0, repos: [] }, o);
}
/* 15 仓：3 个有改动（alpha 纯改动、beta 改动+未跟踪、gamma 纯未跟踪）+ 12 干净；聚合 3改 / 改7 / 新12 */
function build15() {
  const repos = [
    repoEntry('alpha', { changed: 5 }),
    repoEntry('beta', { changed: 2, untracked: 5 }),
    repoEntry('gamma', { untracked: 7 })
  ];
  for (let i = 0; i < 12; i++) repos.push(repoEntry('clean' + i));
  return multiState({ repos });
}
function chipOf(row) {
  return row.children.find(e => e.classList && e.classList.contains('zu-git')) || null;
}
function tipOf(h) {
  return h.body.children.find(e => e.classList.contains('zusage-git-tip')) || null;
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
function sep() { return '<span class="zu-git-sep"> · </span>'; }

test('multi chip base form: ▣ 15仓 · 3改 with middle-dot separators, aggregates in aria', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, build15());
  assert.ok(chip, 'multi chip mounted');
  assert.equal(ui.cua.nextSibling, chip, '紧贴「电脑操作」按钮右侧');
  assert.ok(chip.innerHTML.startsWith('<svg '), 'folder-git 图标打头');
  assert.match(chip.innerHTML, /<span class="zu-git-name">15仓<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-dirty">3改<\/span>/);
  assert.ok(chip.innerHTML.includes(sep()), '语义段用 · 分隔');
  assert.doesNotMatch(chip.innerHTML, /zu-git-m\b|zu-git-d">\(改/, '文件条目汇总不上 chip（在 tooltip）');
  assert.equal(chip.getAttribute('role'), 'status');
  assert.equal(chip.tabIndex, 0);
  assert.match(chip.getAttribute('aria-label'), /Git 15 个仓库/);
  assert.match(chip.getAttribute('aria-label'), /3 个有改动/);
  assert.deepEqual([...h.window.__zusageGitPaths], ['/repo/a'], '上报的仍是工作区（父目录）路径');
});

test('all-clean multi shows only the repo count; m/q sums stay in the tooltip', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const repos = [];
  for (let i = 0; i < 15; i++) repos.push(repoEntry('c' + i));
  const chip = drive(h, ui, multiState({ repos }));
  assert.ok(chip);
  assert.match(chip.innerHTML, /<span class="zu-git-name">15仓<\/span>/);
  assert.doesNotMatch(chip.innerHTML, /zu-git-dirty|zu-git-warn|zu-git-conflict|zu-git-sep/);
  const tip = tipOf(h);
  dispatch(chip, 'mouseenter');
  assert.equal((tip.innerHTML.match(/class="zu-gname"/g) || []).length, 15, '全干净也全量展开 15 行');
  assert.doesNotMatch(tip.innerHTML, /其余 \d+ 个仓库，无本地改动/, '无聚焦行时不插干净组分隔行');
  dispatch(chip, 'mouseleave');
});

test('confirmed conflicts: !N冲突 segment (repo count), red class, stale conflicts not counted', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, multiState({ repos: [
    repoEntry('c-conf', { changed: 3, conflicts: 2 }),
    repoEntry('s-stale', { changed: 1, conflicts: 9, stale: true }),   // 旧缓存的冲突不算已确认
    repoEntry('tidy')
  ] }));
  assert.ok(chip.classList.contains('zu-conflict'));
  assert.match(chip.innerHTML, /<span class="zu-git-conflict">!1冲突<\/span>/, '只统计确认冲突仓库数');
  assert.match(chip.getAttribute('aria-label'), /1 个仓库冲突/);
});

test('failed repos: 已知 prefix on the changed segment plus a 2失败 warning segment', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, multiState({ repos: [
    repoEntry('a', { changed: 1 }),
    repoEntry('b'),
    repoEntry('c'),
    { name: 'd', path: '/w/d', err: 'timeout', stale: true, branch: 'dev', changed: 4, untracked: 0 },   // 携旧快照
    { name: 'e', path: '/w/e', err: 'notrepo' }   // 无旧快照 → 未知
  ] }));
  assert.match(chip.innerHTML, /<span class="zu-git-name">5仓<\/span>/, '总数含失败仓');
  assert.match(chip.innerHTML, /<span class="zu-git-dirty">已知2改<\/span>/, '已知=成功+携旧快照；改含旧快照改动（1+4）');
  assert.match(chip.innerHTML, /<span class="zu-git-warn">2失败<\/span>/);
  assert.match(chip.getAttribute('aria-label'), /已知 2 个有改动/);
  assert.match(chip.getAttribute('aria-label'), /2 个查询失败/);
});

test('workspace-level stale: 上次 prefix plus 过期 text badge (no opacity, no zu-stale class)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, build15());
  h.window.__zusageGitState('/repo/a', { ok: false, reason: 'timeout', ts: 4 });
  const again = chipOf(ui.row);
  assert.equal(again, chip, 'stale 不重建节点');
  assert.ok(!again.classList.contains('zu-stale'), '不再用透明度表达过期');
  assert.match(again.innerHTML, /<span class="zu-git-dirty">上次3改<\/span>/);
  assert.match(again.innerHTML, /<span class="zu-git-warn">过期<\/span>/);
  assert.match(again.getAttribute('aria-label'), /数据已过期/);
  assert.match(again.innerHTML, /15仓/, '内容仍是最近成功结果');
});

test('english wording: 15 repos · 3 changed, aria in english', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const st = build15();
  const chip = drive(h, ui, st);
  h.window.gitTest.state().lang = 'en';
  h.window.__zusageGitState('/repo/a', st);   // lang 进 chip 签名：gitTouch 重渲染即生效
  const again = chipOf(ui.row);
  assert.equal(again, chip, '切语言只改内容不重建节点');
  assert.match(again.innerHTML, /<span class="zu-git-name">15 repos<\/span>/);
  assert.match(again.innerHTML, /<span class="zu-git-dirty">3 changed<\/span>/);
  assert.doesNotMatch(again.innerHTML, /仓|待提|改</);
  assert.match(again.getAttribute('aria-label'), /15 repos/);
  assert.match(again.getAttribute('aria-label'), /3 with changes/);
});

test('compact mode: repo count hidden, semantic segments remain (all clean → icon only class-wise)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, build15());
  ui.cua.setAttribute('data-composer-compact', 'true');
  h.tick();
  assert.ok(chip.classList.contains('zu-compact'));
  assert.match(chip.innerHTML, /3改/, '有改动段保留');
  ui.cua.setAttribute('data-composer-compact', 'false');
  h.tick();
  assert.ok(!chip.classList.contains('zu-compact'));
});

test('multi → notrepo unmounts, re-push multi restores', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  assert.ok(drive(h, ui, build15()));
  h.window.__zusageGitState('/repo/a', { ok: false, reason: 'notrepo', ts: 5 });
  assert.equal(chipOf(ui.row), null, 'notrepo 摘除 chip');
  h.window.__zusageGitState('/repo/a', multiState({ repos: [repoEntry('a'), repoEntry('b')] }));
  assert.ok(chipOf(ui.row), 'multi 恢复挂载');
});

test('multi → single shape re-renders the same node as a branch chip (2 仓删剩 1 仓)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, multiState({ repos: [repoEntry('a'), repoEntry('b', { changed: 2 })] }));
  assert.match(chip.innerHTML, /2仓/);
  h.window.__zusageGitState('/repo/a', gitState({ repoPath: '/w/a' }));
  const again = chipOf(ui.row);
  assert.equal(again, chip, '同一节点重渲染');
  assert.match(again.innerHTML, /zu-git-name">main</, '切回单仓分支形态');
  assert.match(again.innerHTML, /\+1328/, '单仓行数段出现');
  assert.ok(!again.classList.contains('zu-git-multi'), '形态类摘除');
});

test('more stays out of the chip repo count (份数只算已统计仓)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, multiState({ repos: [repoEntry('a'), repoEntry('b'), repoEntry('c', { changed: 1 })], more: 5 }));
  assert.match(chip.innerHTML, /<span class="zu-git-name">3仓<\/span>/, '份数=已统计 3，不含 more:5');
  assert.match(chip.getAttribute('aria-label'), /Git 3 个仓库/);
  assert.doesNotMatch(chip.innerHTML, /8仓/);
});

test('re-push is idempotent (same node, same signature); dispose removes the chip', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const st = build15();
  const chip = drive(h, ui, st);
  const sig = chip.__zuSig, html = chip.innerHTML;
  h.window.__zusageGitState('/repo/a', st);
  h.tick(); h.tick();
  assert.equal(chipOf(ui.row), chip);
  assert.equal(chip.__zuSig, sig);
  assert.equal(chip.innerHTML, html);
  h.window.gitTest.instances()[0].dispose();
  assert.equal(chipOf(ui.row), null, 'dispose 摘除本 pane 的 chip');
});

test('tooltip overview: title, with-changes line, entry-sums line with units (改/新=项)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, build15());
  const tip = tipOf(h);
  dispatch(chip, 'mouseenter');
  assert.equal(tip.style.display, 'block');
  assert.match(tip.innerHTML, /<div class="rt-h">⎇ Git 状态 · 15 个仓库<\/div>/);
  assert.match(tip.innerHTML, /有改动 <b class="c-mod">3<\/b> 个仓库/);
  assert.match(tip.innerHTML, /已跟踪变更 <b class="c-mod">7<\/b> 项/);
  assert.match(tip.innerHTML, /未跟踪 <b class="c-unt">12<\/b> 项/);
  assert.doesNotMatch(tip.innerHTML, /已确认 \d+\/\d+/, '全部成功时无覆盖率行');
  assert.ok(tip.innerHTML.includes('class="zu-git-rows"'), '行列表在滚动容器内');
  assert.match(tip.innerHTML, /工作目录<\/b><span>\/repo\/a，下含 15 个仓库/, '底部为工作目录口径');
  assert.match(tip.innerHTML, /更新于/);
  assert.match(tip.innerHTML, /口径：改=已跟踪变更条目/, '一句口径说明');
  dispatch(chip, 'mouseleave');
});

test('coverage line and per-repo failure rows: reason text, stale carry marked 过期', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, multiState({ repos: [
    repoEntry('alpha', { changed: 4, untracked: 2 }),
    { name: 'broken', path: '/w/broken', err: 'timeout', stale: true, branch: 'dev', changed: 6, untracked: 1 },
    { name: 'lost', path: '/w/lost', err: 'notrepo' }
  ] }));
  assert.match(chip.innerHTML, /<span class="zu-git-warn">2失败<\/span>/);
  const tip = tipOf(h);
  dispatch(chip, 'mouseenter');
  assert.match(tip.innerHTML, /已确认 2\/3 个仓库 · 2 个查询失败/, '覆盖率行（携旧快照的失败仓计入已确认）');
  assert.match(tip.innerHTML, /⚠ 查询失败（超时）/, '失败行带原因');
  assert.match(tip.innerHTML, /过期；以下为上次结果/, '携旧快照的失败行标注历史属性');
  assert.match(tip.innerHTML, /改 6 项/, '旧快照改动仍可见');
  assert.ok(tip.innerHTML.includes('>lost</b>'), '无旧快照失败行也全量可见');
  dispatch(chip, 'mouseleave');
});

test('tooltip rows sort by priority (冲突→失败过期→操作→有改动→上游差异→干净) with clean divider', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, multiState({ repos: [   // 乱序推送
    repoEntry('z-clean'),
    repoEntry('up-only', { ahead: 1 }),
    repoEntry('a-dirty', { changed: 1 }),
    repoEntry('mid-op', { op: 'rebase' }),
    { name: 'f-fail', path: '/w/f', err: 'error' },
    repoEntry('c-conf', { changed: 2, conflicts: 1 })
  ] }));
  const tip = tipOf(h);
  dispatch(chip, 'mouseenter');
  let pos = -1;
  for (const name of ['c-conf', 'f-fail', 'mid-op', 'a-dirty', 'up-only', 'z-clean']) {
    const at = tip.innerHTML.indexOf('>' + name + '</b>');
    assert.ok(at > pos, name + ' 行序符合优先级（同级码点序）');
    pos = at;
  }
  assert.match(tip.innerHTML, /zu-gdiv"><span>其余 1 个仓库，无本地改动/, '干净组前插分隔行（全部行仍可访问）');
  assert.match(tip.innerHTML, /<span class="zu-gconf">!1 冲突<\/span>/, '冲突标签红+文字');
  assert.match(tip.innerHTML, /<span class="c-op">变基<\/span>/, '操作名标签');
  assert.match(tip.innerHTML, /<span class="c-warn">⚠ 查询失败（出错）<\/span>/, '失败行带原因');
  assert.ok(tip.innerHTML.includes('>up-only</b><span><span class="zu-gbr">main</span> ↑1</span>'), '纯上游差异行：↑ 中性色无标签');
  assert.ok(tip.innerHTML.includes('>a-dirty</b><span><span class="zu-gbr">main</span> <span class="c-mod">改 1 项</span></span>'), '改动行：改 N 项');
  dispatch(chip, 'mouseleave');
});

test('rows carry full repo path via title attribute (escaped)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, multiState({ repos: [
    repoEntry('a"quote', { changed: 1, path: '/w/a"quote' })
  ] }));
  const tip = tipOf(h);
  dispatch(chip, 'mouseenter');
  assert.ok(tip.innerHTML.includes('title="/w/a&quot;quote"'), 'title 属性转义双引号，完整路径可访问');
  dispatch(chip, 'mouseleave');
});

test('multi tooltip in english, stale flag, work-dir row and time format', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const st = multiState({ repos: [repoEntry('alpha', { changed: 2 }), repoEntry('beta', { untracked: 1 })] });
  const chip = drive(h, ui, st);
  h.window.gitTest.state().lang = 'en';
  h.window.__zusageGitState('/repo/a', st);   // lang 进 chip 签名：重渲染为英文
  h.window.__zusageGitState('/repo/a', { ok: false, reason: 'timeout', ts: 6 });   // 保 lastGood 标 stale
  const chip2 = chipOf(ui.row);
  assert.equal(chip2, chip, 'stale 不重建节点');
  const tip = tipOf(h);
  dispatch(chip2, 'mouseenter');
  assert.match(tip.innerHTML, /Git status · 2 repos/, '英文标题');
  assert.match(tip.innerHTML, /2<\/b> repos with changes/, '英文概览');
  assert.match(tip.innerHTML, /last query failed/, 'stale 标注');
  assert.match(tip.innerHTML, /Work dir<\/b><span>\/repo\/a · 2 repos/, '英文工作目录行');
  assert.match(tip.innerHTML, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, '更新时间 yyyy-MM-dd HH:mm:ss');
  assert.doesNotMatch(tip.innerHTML, /个仓库|有改动|更新于|待提交/, '英文态无中文残留');
  dispatch(chip2, 'mouseleave');
});

test('single-repo tooltip: upstream-unset reason, operation row, entry units, stale note', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, gitState({ repoPath: '/w/only', upstream: '', op: 'merge' }));
  h.window.__zusageGitState('/repo/a', { ok: false, reason: 'timeout', ts: 7 });   // 单仓过期走"成功后失败"路径
  const tip = tipOf(h);
  dispatch(chip, 'mouseenter');
  assert.match(tip.innerHTML, /未设置上游分支（↑↓ 不可用）/, '无上游明确原因');
  assert.match(tip.innerHTML, /进行中操作<\/b><span>合并/, '操作行');
  assert.match(tip.innerHTML, /已暂存<\/b><span>3 项/, '条目单位（不冒充文件数）');
  assert.match(tip.innerHTML, /未跟踪<\/b><span>1 项（目录折叠计 1）/, '未跟踪折叠口径');
  assert.match(tip.innerHTML, /上次查询失败，显示的是最近成功结果/, '数据质量标注');
  assert.match(tip.innerHTML, /不自动 fetch/, '不自动 fetch 说明');
  assert.match(chip.innerHTML, /<span class="zu-git-warn">过期<\/span>/, '单仓 chip 过期徽章');
  dispatch(chip, 'mouseleave');
});

test('tooltip rebuild is skipped while content is unchanged (scroll wheel & scrollbar drag stability)', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const st = build15();
  const chip = drive(h, ui, st);
  const tip = tipOf(h);
  dispatch(chip, 'mouseenter');
  assert.equal(tip.style.display, 'block');
  tip.innerHTML = 'SENTINEL';   // 人为置哨兵：若 600ms 对账仍无条件重建，哨兵会被冲掉
  h.tick(); h.tick();
  assert.equal(tip.innerHTML, 'SENTINEL', '内容签名不变不重建 innerHTML（滚轮/滚动条拖拽不被打断）');
  assert.equal(tip.style.display, 'block', '跳过重建不影响显示与定位');
  h.window.__zusageGitState('/repo/a', multiState({ repos: [repoEntry('only', { changed: 1 })] }));   // 数据真变
  h.tick();
  assert.notEqual(tip.innerHTML, 'SENTINEL', '内容变化才重建');
  assert.match(tip.innerHTML, /Git 状态 · 1 个仓库/);
});

test('multi chip styles: semantic palette, light variants, scroll container, no stale opacity', () => {
  assert.match(source, /\.zu-git \.zu-git-dirty\{color:#f0e6a0\}/);
  assert.match(source, /\.zu-git\.zu-conflict \.zu-git-dirty\{color:#f09696\}/);
  assert.match(source, /\.zu-git-conflict\{color:#f09696\}/);
  assert.match(source, /\.zu-git-warn\{color:#f0e6a0\}/);
  assert.match(source, /\.zu-git-op\{color:#afafb2\}/);
  assert.match(source, /\.zu-git-sep\{opacity:\.6\}/);
  assert.match(source, /\.zu-git\[data-zusage-light\] \.zu-git-conflict\{color:#d20f39\}/);
  assert.match(source, /\.zu-git\[data-zusage-light\] \.zu-git-warn\{color:#946200\}/);
  assert.match(source, /\.zu-git\.zu-compact \.zu-git-name,\.zu-git\.zu-compact \.zu-git-ab\{display:none\}/);
  assert.match(source, /\.zu-git\.zu-compact\.zu-git-multi \.zu-git-d\{display:none\}/);
  assert.match(source, /\.zusage-git-tip \.c-mod,\.zusage-git-tip \.c-unt,\.zusage-git-tip \.c-warn\{color:#f0e6a0\}/);
  assert.match(source, /\.zusage-git-tip\[data-zusage-light\] \.c-mod,\.zusage-git-tip\[data-zusage-light\] \.c-unt,\.zusage-git-tip\[data-zusage-light\] \.c-warn\{color:#946200\}/);
  assert.match(source, /\.zusage-git-tip\[data-zusage-light\] \.zu-gconf\{color:#d20f39\}/);
  assert.match(source, /\.zusage-git-tip \.zu-git-rows\{max-height:60vh;overflow-y:auto/);
  assert.doesNotMatch(source, /zu-git\.zu-stale|zu-stale\{opacity/, '过期不再用透明度表达');
  assert.match(source, /data-k="git"/);
});

test('interaction wiring: Esc close, hover bridge into tooltip, scroll position preserved on refresh', () => {
  assert.match(source, /window\.addEventListener\("keydown", onGitKeydown, true\)/, 'Esc 关闭');
  assert.match(source, /function hideGitTipSoon\(\)/, '鼠标移入悬浮内容的宽限桥');
  assert.match(source, /gitTip\.addEventListener\("mouseenter", onGitTipEnter\)/);
  assert.match(source, /gitTip\.addEventListener\("mouseleave", hideGitTip\)/);
  assert.match(source, /chip\.addEventListener\("mouseleave", hideGitTipSoon\)/);
  assert.match(source, /var keep = 0;/, '自动刷新保持滚动位置');
  assert.match(source, /rowsEl\.scrollTop = keep/, '重渲染后恢复滚动位置');
  assert.match(source, /if \(e && e\.key === "Escape"\) hideGitTip\(\)/);
});
