const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v96 Git 状态 chip：整 IIFE 执行 + instances/state 接缝（同 overlay-ctxbtn 模式）。
 * 夹具：工具行 = ctx wrapper + 「电脑操作」按钮（v4-composer-cua-entry）兄弟节点；pane 节点自身带
 * scope 属性（data-zusage-scope-version/workspace-path 等），经 coordinator 派实例、__zusageUpdate
 * 推数据后由 window.__zusageGitState 模拟主进程回推，断言挂载位置/内容/幂等/还原/路径上报。 */
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
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' }, localStorage: { getItem: () => null, setItem() {} },
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
  return { window, body, inject, tick, boot, buildComposer, payload };
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

test('chip mounts right of the CUA button with cc-pretty-statusline styling', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  assert.ok(chip, 'chip mounted');
  const live = ui.row.parentElement.children.find(e => e.classList.contains('zusage-root'))?.querySelector('.zu-sr-only');
  assert.ok(live, 'a visually hidden live region is mounted inside this pane bar');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.getAttribute('role'), 'status');
  assert.equal(live.getAttribute('aria-atomic'), 'true');
  assert.equal(chip.getAttribute('role'), 'button');
  assert.equal(chip.parentElement, ui.row, 'button chip remains directly after the CUA button');
  assert.match(live.textContent, /Git 分支 main/);
  const before = live.textContent;
  h.window.__zusageGitState('/repo/a', gitState({ branch: 'release', ahead: 0, behind: 0 }));
  assert.match(live.textContent, /Git 分支 release/);
  const changed = live.textContent;
  h.window.__zusageGitState('/repo/a', gitState({ branch: 'release', ahead: 0, behind: 0 }));
  assert.equal(live.textContent, changed, 'same status is not re-announced');
  assert.notEqual(before, changed);
  assert.equal(ui.cua.nextSibling, chip, '紧贴「电脑操作」按钮右侧');
  h.window.__zusageGitState('/repo/a', gitState());
  assert.ok(chip.innerHTML.startsWith('<svg '), 'lucide git-branch 图标打头');
  assert.match(chip.innerHTML, /<span class="zu-git-name">main<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-ab">↑2 ↓1<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-ins">\+1328<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-del">-223<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-unt">\?1<\/span>/);
  assert.match(chip.innerHTML, /\(\s*<span class="zu-git-ins">/, '计数段由暗灰括号包裹');
  assert.equal(chip.getAttribute('role'), 'button');
  assert.equal(chip.tabIndex, 0);
  assert.match(chip.getAttribute('aria-label'), /Git 分支 main/);
  assert.match(chip.getAttribute('aria-label'), /领先 2/);
  assert.deepEqual([...h.window.__zusageGitPaths], ['/repo/a'], '本地工作区路径上报主进程');
});

function leadingOf(ui) {
  const leading = ui.row.appendChild(new Element());
  leading.setAttribute('data-composer-leading-content', 'true');
  const modes = leading.appendChild(new Element());
  const mode = modes.appendChild(new Element('button'));
  mode.setAttribute('data-testid', 'chat-mode-select-trigger');
  leading.appendChild(ui.cua);
  return { leading, modes, mode };
}

test('CUA disabled keeps Git in leading content, outside mode wrapper and right controls', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const { leading, modes } = leadingOf(ui);
  ui.cua.remove(); drive(h, ui);
  const chip = chipOf(leading);
  assert.ok(chip);
  assert.equal(leading.children.at(-1), chip);
  assert.equal(modes.nextSibling, chip);
  assert.equal(chipOf(ui.wrap), null);
  assert.ok(!modes.contains(chip));
  leading.appendChild(ui.cua);
  const extra = leading.appendChild(new Element('button'));
  h.tick();
  assert.equal(ui.cua.nextSibling, chip);
  assert.equal(chip.nextSibling, extra);
  ui.cua.style.visibility = 'hidden'; h.tick();
  assert.equal(extra.nextSibling, chip);
  ui.cua.remove(); h.tick();
  assert.equal(chipOf(leading), chip);
  assert.equal(leading.children.at(-1), chip);
});

test('leading content can mount without CUA or mode and repairs React displacement', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const { leading, modes } = leadingOf(ui);
  ui.cua.remove(); modes.remove(); drive(h, ui);
  const chip = chipOf(leading); assert.ok(chip);
  const attachment = leading.appendChild(new Element('button'));
  h.tick(); assert.equal(attachment.nextSibling, chip);
  h.window.gitTest.instances()[0].dispose(); assert.equal(chipOf(leading), null);
});

test('legacy mode fallback mounts beside its wrapper, never at context or thought', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  ui.cua.remove(); const modes = ui.row.appendChild(new Element());
  const mode = modes.appendChild(new Element('button'));mode.setAttribute('data-testid', 'chat-mode-select-trigger');
  drive(h, ui); const chip=chipOf(ui.row);assert.ok(chip);assert.equal(modes.nextSibling,chip);
  modes.remove();h.tick();assert.equal(chipOf(ui.row),null);assert.equal(chipOf(ui.wrap),null);
});

for (const hidden of ['inert', 'display', 'visibility']) {
  test(`hidden ${hidden} leading probe is ignored`, () => {
    const h=harness(),ui=h.buildComposer('workspace-main','sid_main');
    const probe=ui.row.appendChild(new Element());probe.setAttribute('data-composer-leading-content','true');
    if(hidden==='inert')probe.inert=true;else probe.style[hidden]=hidden==='display'?'none':'hidden';
    const {leading}=leadingOf(ui);ui.cua.remove();drive(h,ui);
    assert.ok(chipOf(leading));assert.equal(chipOf(probe),null);
  });
}

test('leading content rebuild replaces detached chip and preserves pane data', () => {
  const h = harness(), a = h.buildComposer('workspace-main', 'sid_main');
  const b = h.buildComposer('pane-b', 'sid_b', { repoPath: '/repo/b' });
  const x = leadingOf(a), y = leadingOf(b);
  a.cua.remove(); b.cua.remove(); drive(h, a);
  h.window.__zusageGitState('/repo/b', { ok: true, kind: 'multi', repos: [{ path: '/repo/b/child', ...gitState() }], failed: 0 });
  const old = chipOf(x.leading), other = chipOf(y.leading);
  assert.ok(old); assert.ok(other); assert.notEqual(old, other);
  assert.match(old.innerHTML, /zu-git-name">main/);
  assert.ok(other.classList.contains('zu-git-multi'));
  assert.match(other.innerHTML, /1仓/);
  dispatch(old, 'mouseenter');
  const tip = h.body.children.find(e => e.classList.contains('zusage-git-tip'));
  x.leading.remove(); assert.equal(old.isConnected, false);
  const z = leadingOf(a); a.cua.remove(); h.tick();
  const replacement = chipOf(z.leading);
  assert.ok(replacement); assert.notEqual(replacement, old);
  assert.equal(tip.style.display, 'none');
  assert.equal(z.leading.children.filter(e => e.classList.contains('zu-git')).length, 1);
  assert.equal(chipOf(a.wrap), null);
  assert.match(replacement.innerHTML, /zu-git-name">main/);
  assert.equal(chipOf(y.leading), other);
});

for (const outside of [false, true]) {
  test(`legacy mode ${outside ? 'outside toolbar' : 'direct toolbar child'} stays within its boundary`, () => {
    const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
    ui.cua.remove();
    const mode = (outside ? ui.card : ui.row).appendChild(new Element('button'));
    mode.setAttribute('data-testid', 'chat-mode-select-trigger'); drive(h, ui);
    const chip = chipOf(ui.row);
    if (outside) { assert.equal(chip, null); assert.equal(chipOf(h.body), null); assert.equal(chipOf(ui.card), null); }
    else { assert.ok(chip); assert.equal(mode.nextSibling, chip); }
  });
}

test('legacy mode never escapes the card into an outer toolbar', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  ui.cua.remove();
  const outer = h.body.appendChild(new Element());
  outer.className = 'group/toolbar'; outer.appendChild(ui.card);
  const mode = ui.card.appendChild(new Element('button'));
  mode.setAttribute('data-testid', 'chat-mode-select-trigger');
  drive(h, ui);
  assert.equal(chipOf(outer), null);
  assert.equal(chipOf(ui.card), null);
  assert.equal(chipOf(ui.row), null);
});

test('without CUA the mode compact state converges and expands with room', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const { leading, mode } = leadingOf(ui); ui.cua.remove();
  mode.setAttribute('data-composer-compact', 'true'); drive(h, ui);
  const chip = chipOf(leading); assert.ok(chip);
  assert.equal(chip.classList.contains('zu-compact'), true);
  const available = ui.row.appendChild(new Element());
  available.setAttribute('data-composer-leading-actions', 'true'); available.appendChild(leading);
  ui.row.clientWidth = 600; ui.row.getBoundingClientRect = () => ({ width: 600 });
  let budget = 300;
  available.getBoundingClientRect = () => ({ width: budget });
  leading.getBoundingClientRect = () => ({ width: 250, height: 28 });
  chip.getBoundingClientRect = () => ({ width: chip.classList.contains('zu-compact') ? 70 : 210 });
  chip.cloneNode = () => { const p = new Element('span'); p.className = chip.className; p.getBoundingClientRect = () => ({ width: p.classList.contains('zu-compact') ? 70 : 210 }); return p; };
  const hidden = ui.row.appendChild(new Element()); hidden.inert = true;
  hidden.setAttribute('data-composer-leading-content', 'true');
  ui.row.queries.set('[data-composer-leading-content]', hidden);
  ui.row.queries.set('[data-composer-leading-actions]', hidden);
  mode.setAttribute('data-composer-compact', 'false');
  for (let i = 0; i < 20; i++) { h.tick(); assert.equal(chip.classList.contains('zu-compact'), true); }
  budget = 500; h.tick(); assert.equal(chip.classList.contains('zu-compact'), false);
  mode.setAttribute('data-composer-compact', 'true'); h.tick(); assert.equal(chip.classList.contains('zu-compact'), true);
});

test('clean worktree keeps the chip to branch only: no parens, no arrows', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, gitState({ upstream: '', ahead: 0, behind: 0, ins: 0, del: 0, untracked: 0, staged: 0, unstaged: 0 }));
  assert.ok(chip);
  assert.doesNotMatch(chip.innerHTML, /zu-git-d|zu-git-ab|zu-git-ins|zu-git-del|zu-git-unt/);
  assert.match(chip.innerHTML, /zu-git-name">main</);
  const h2 = harness(), ui2 = h2.buildComposer('workspace-main', 'sid_main');
  const det = drive(h2, ui2, gitState({ detached: true, branch: '', upstream: '', ahead: 0, behind: 0, ins: 0, del: 0, untracked: 0 }));
  assert.match(det.innerHTML, /zu-git-name">HEAD</, '游离 HEAD 显示 HEAD');
});

test('notrepo and nogit unmount the chip entirely', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  assert.ok(drive(h, ui));
  h.window.__zusageGitState('/repo/a', { ok: false, reason: 'notrepo', ts: 1 });
  assert.equal(chipOf(ui.row), null);
  h.window.__zusageGitState('/repo/a', gitState());
  assert.ok(chipOf(ui.row));
  h.window.__zusageGitState('/repo/a', { ok: false, reason: 'nogit', ts: 2 });
  assert.equal(chipOf(ui.row), null);
});

test('timeout keeps the last good state flagged stale instead of clearing', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  h.window.__zusageGitState('/repo/a', { ok: false, reason: 'timeout', ts: 3 });
  const again = chipOf(ui.row);
  assert.equal(again, chip, '节点不重建');
  assert.ok(!again.classList.contains('zu-stale'), '过期不用透明度表达');
  assert.match(again.innerHTML, /<span class="zu-git-warn">过期<\/span>/, '过期文字徽章');
  assert.match(again.getAttribute('aria-label'), /数据已过期/);
  assert.match(again.innerHTML, /main/, '内容仍是最近成功结果');
});

test('remote panes report no path and never mount the chip', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main', { identity: 'remote:ssh:a:22:u:/p', remote: 'rs1' });
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload());
  h.window.__zusageGitState('/repo/a', gitState());   // 即便主进程推了同名路径，远端 pane 也不消费
  assert.deepEqual([...h.window.__zusageGitPaths], []);
  assert.equal(chipOf(ui.row), null);
});

test('react displacement is healed back to the right of the CUA button', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  ui.row.children.splice(ui.row.children.indexOf(chip), 1);
  ui.row.children.unshift(chip);   // 模拟 React 重渲染把手动节点挤到行首
  h.tick();
  assert.equal(ui.cua.nextSibling, chip);
});

test('reapply is idempotent: same node, signature and inner html unchanged', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  const sig = chip.__zuSig, html = chip.innerHTML;
  h.window.__zusageGitState('/repo/a', gitState());
  h.tick(); h.tick();
  assert.equal(chipOf(ui.row), chip);
  assert.equal(chip.__zuSig, sig);
  assert.equal(chip.innerHTML, html);
  assert.equal(ui.row.children.filter(e => e.classList.contains('zu-git')).length, 1);
});

test('disabling the setting unmounts the chip and clears the reported path set', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  assert.ok(drive(h, ui));
  h.window.gitTest.state().show.git = 0;
  h.window.__zusageUpdate(h.payload());   // render → enhanceGitChip 还原；publishGitPaths → 空集
  assert.equal(chipOf(ui.row), null);
  assert.deepEqual([...h.window.__zusageGitPaths], []);
});

test('dispose removes the chip of its own pane', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  assert.ok(drive(h, ui));
  h.window.gitTest.instances()[0].dispose();
  assert.equal(chipOf(ui.row), null);
});

test('composer compact mode collapses the branch name and arrows', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  assert.ok(!chip.classList.contains('zu-compact'));
  ui.cua.setAttribute('data-composer-compact', 'true');
  h.tick();
  assert.ok(chip.classList.contains('zu-compact'));
  ui.cua.setAttribute('data-composer-compact', 'false');
  h.tick();
  assert.ok(!chip.classList.contains('zu-compact'));
});

function fitFeedback(h, ui, chip, width) {
  ui.row.clientWidth = width;
  ui.row.getBoundingClientRect = () => ({ width });
  const nativeWidth = 230, compactNativeWidth = 170, fullChipWidth = 210, compactChipWidth = 70;
  ui.row.children.forEach(el => {
    el.getBoundingClientRect = () => ({ height: 28, width: el === chip ? (chip.classList.contains('zu-compact') ? compactChipWidth : fullChipWidth) : el === ui.cua ? (ui.cua.getAttribute('data-composer-compact') === 'true' ? compactNativeWidth : nativeWidth) : 0 });
  });
  chip.cloneNode = () => {
    const probe = new Element('span');
    probe.className = chip.className;
    probe.getBoundingClientRect = () => ({ width: probe.classList.contains('zu-compact') ? compactChipWidth : fullChipWidth });
    return probe;
  };
  return () => {
    const measuredChip = chip.classList.contains('zu-compact') ? compactChipWidth : fullChipWidth;
    ui.cua.setAttribute('data-composer-compact', String(nativeWidth + measuredChip > ui.row.clientWidth));
    h.window.__zusageGitState('/repo/a', gitState());
    return chip.classList.contains('zu-compact');
  };
}

test('Git compact feedback converges at fixed width and expands after enough room returns', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  const step = fitFeedback(h, ui, chip, 360);
  const modes = Array.from({ length: 200 }, step);
  assert.equal(modes.filter((mode, i) => i && mode !== modes[i - 1]).length, 0, 'no repeated folding at a fixed width');
  assert.ok(modes.every(Boolean), 'compact chip remains stable even when native labels return');
  ui.row.clientWidth = 600;
  for (let i = 0; i < 10; i++) step();
  assert.ok(!chip.classList.contains('zu-compact'), 'widening restores the full chip');
  for (let i = 0; i < 200; i++) assert.equal(step(), false, 'wide layout stays expanded');
});

test('Git compact expansion reserves the full chip width and a hysteresis margin', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  const step = fitFeedback(h, ui, chip, 360);
  step();
  ui.row.clientWidth = 450;
  for (let i = 0; i < 20; i++) assert.equal(step(), true, 'ten free pixels cannot cover the safety margin');
  ui.row.clientWidth = 480;
  assert.equal(step(), false, 'full chip plus margin fits');
});

test('Git compact measures the leading budget without hiding or moving the live chip', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  ui.cua.setAttribute('data-composer-compact', 'true'); h.tick();
  ui.cua.setAttribute('data-composer-compact', 'false');
  ui.row.clientWidth = 600;
  ui.row.getBoundingClientRect = () => ({ width: 600 });
  const content = new Element(), available = new Element(), trailing = new Element();
  content.setAttribute('data-composer-leading-content', '');
  available.setAttribute('data-composer-leading-actions', '');
  trailing.setAttribute('data-composer-trailing-actions', '');
  content.getBoundingClientRect = () => ({ width: 250 });
  let budget = 300;
  available.getBoundingClientRect = () => ({ width: budget });
  trailing.getBoundingClientRect = () => ({ width: 100 });
  ui.row.queries.set('[data-composer-leading-content]', content);
  ui.row.queries.set('[data-composer-leading-actions]', available);
  ui.row.queries.set('[data-composer-trailing-actions]', trailing);
  chip.getBoundingClientRect = () => ({ width: 70 });
  let fullWidth = 210;
  chip.cloneNode = () => {
    const probe = new Element('span');
    probe.className = chip.className;
    probe.getBoundingClientRect = () => ({ width: probe.classList.contains('zu-compact') ? 70 : fullWidth });
    return probe;
  };
  const children = h.body.children.length;
  h.tick();
  assert.ok(chip.classList.contains('zu-compact'), 'outer row space cannot override the leading budget');
  assert.equal(chip.parentElement, ui.row);
  assert.equal(h.body.children.length, children, 'probe is removed after measurement');
  budget = 450; h.tick();
  assert.ok(!chip.classList.contains('zu-compact'));
  ui.cua.setAttribute('data-composer-compact', 'true'); h.tick();
  ui.cua.setAttribute('data-composer-compact', 'false');
  fullWidth = 350; budget = 600; h.tick();
  assert.ok(chip.classList.contains('zu-compact'), 'trailing controls also constrain the full layout');
  chip.cloneNode = () => {
    const probe = new Element('span');
    probe.getBoundingClientRect = () => { throw new Error('unmeasurable'); };
    return probe;
  };
  h.tick();
  assert.ok(!chip.classList.contains('zu-compact'), 'unknown DOM falls back to host mode');
  assert.equal(h.body.children.length, children);
});

test('long branch names truncate to 16 chars with ellipsis and html-escape', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, gitState({ branch: '<feat/very-long-branch-name-x>' }));
  assert.match(chip.innerHTML, /zu-git-name">&lt;feat\/very-long-…<\/span>/);
});

test('refresh requests: first scope resolution asks once, snapshots throttle, click forces', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const asks = () => h.window.__zusagePluginRequests.filter(r => r.action === 'git-refresh').length;
  assert.equal(asks(), 1, '协调器派发 pane、scope 解析成功即上报路径并请求首查（不必等首个快照）');
  h.window.__zusageUpdate(h.payload());
  assert.equal(asks(), 1, '路径集未变的快照重推被节流');
  h.window.__zusageGitState('/repo/a', gitState());
  const chip = chipOf(ui.row);
  const live = ui.row.parentElement.children.find(e => e.classList.contains('zusage-root')).querySelector('.zu-sr-only');
  dispatch(chip, 'click');
  assert.equal(asks(), 2, '点击绕过节流');
  assert.ok(chip.classList.contains('zu-gbusy'));
  assert.equal(chip.getAttribute('aria-busy'), 'true');
  assert.equal(live.textContent, 'Git 状态查询中');
  const request = h.window.__zusagePluginRequests.filter(r => r.action === 'git-refresh').find(r => r.requestId);
  dispatch(chip, 'click');
  const afterSecondClick = h.window.__zusagePluginRequests.filter(r => r.action === 'git-refresh').filter(r => r.requestId);
  assert.equal(afterSecondClick.length, 1, 'same-pane repeat click does not enqueue another request');
  assert.equal(afterSecondClick[0].requestId, request.requestId, 'same-pane repeat click does not replace the in-flight request');
  assert.ok(request, '手动刷新携带请求回执 ID');
  h.window.__zusagePluginResult({ id: request.requestId, ok: true, pending: false });
  assert.equal(chip.getAttribute('aria-busy'), 'false');
  assert.match(live.textContent, /Git 状态已更新：Git 分支 main/);
});

test('refresh completion for a prior composer is ignored after pane scope changes', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  dispatch(chip, 'click');
  const oldRequest = h.window.__zusagePluginRequests.filter(r => r.action === 'git-refresh').find(r => r.requestId);
  assert.ok(oldRequest);
  const inst = h.window.gitTest.instances()[0];
  ui.editor.sid = 'sid_other';
  ui.editor.setAttribute('data-session-id', 'sid_other');
  ui.editor.setAttribute('data-zusage-workspace-path', '/repo/b');
  const live = ui.row.parentElement.querySelector('.zu-sr-only');
  h.window.__zusagePluginResult({ id: oldRequest.requestId, ok: true });
  assert.equal(chip.getAttribute('aria-busy'), 'false', 'a stale scope receipt releases only the old busy state');
  assert.doesNotMatch(live.textContent, /Git 状态已更新/);
  inst.attach(ui.editor, 'sid_other');
  h.window.__zusageUpdate({ remote_evidence: false, today: {}, not_local: [],
    recent: [{ sid: 'sid_other', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1 }] });
  h.window.__zusageGitState('/repo/b', gitState({ branch: 'other', ahead: 0, behind: 0 }));
  const newChip = chipOf(ui.row);
  assert.ok(newChip, 'new workspace scope mounts its Git chip');
  dispatch(newChip, 'click');
  const newRequest = h.window.__zusagePluginRequests.filter(r => r.action === 'git-refresh').find(r => r.requestId && r.requestId !== oldRequest.requestId);
  assert.ok(newRequest, 'new workspace can start a fresh request');
  assert.equal(newChip.getAttribute('aria-busy'), 'true');
  assert.equal(live.textContent, 'Git 状态查询中', 'new request has its own in-progress announcement');
});

test('hover tooltip shows branch, upstream, counts, directory and refresh hint', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  const tip = h.body.children.find(e => e.classList.contains('zusage-git-tip'));
  assert.ok(tip, 'document 级 tooltip 单例');
  dispatch(chip, 'mouseenter');
  assert.equal(tip.style.display, 'block');
  assert.match(tip.innerHTML, /origin\/main ↑2 ↓1/);
  assert.match(tip.innerHTML, /已暂存/);
  assert.match(tip.innerHTML, /未跟踪/);
  assert.match(tip.innerHTML, /\/repo\/a/, '目录行');
  assert.match(tip.innerHTML, /更新于/);
  assert.match(tip.innerHTML, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, '时间格式 yyyy-MM-dd HH:mm:ss');
  dispatch(chip, 'mouseleave');
  assert.equal(tip.style.display, 'block', '悬停桥：移入 tooltip 前保持显示（延迟收起）');
  dispatch(h.window, 'keydown', { key: 'Escape' });
  assert.equal(tip.style.display, 'none', 'Esc 关闭');
});

test('reinjection cleans the old chip and tooltip, then rebuilds', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui);
  h.inject();   // 模拟热更重注入：旧代 dispose 链应摘掉旧 chip/tooltip
  assert.equal(chip.isConnected, false);
  assert.equal(chipOf(ui.row), null);
  assert.ok(h.body.children.find(e => e.classList.contains('zusage-git-tip')), '新代重建 tooltip');
});

test('chip styles carry the cc-pretty-statusline palette, light variants and compact rule', () => {
  assert.match(source, /\.zu-git\{[^}]*height:1\.75rem/);
  assert.match(source, /\.zu-git\{[^}]*color:#afafb2/);
  assert.match(source, /\.zu-git \.zu-git-ins\{color:#aae6aa\}/);
  assert.match(source, /\.zu-git \.zu-git-del\{color:#f09696\}/);
  assert.match(source, /\.zu-git \.zu-git-unt\{color:#f0e6a0\}/);
  assert.match(source, /\.zu-git\[data-zusage-light\]\{color:#6c6f85\}/);
  assert.match(source, /\.zu-git\[data-zusage-light\] \.zu-git-ins\{color:#2da587\}/);
  assert.match(source, /\.zu-git\[data-zusage-light\] \.zu-git-del\{color:#d20f39\}/);
  assert.match(source, /\.zu-git\[data-zusage-light\] \.zu-git-unt\{color:#df8e1d\}/);
  assert.match(source, /\.zu-git\.zu-compact \.zu-git-name,\.zu-git\.zu-compact \.zu-git-ab\{display:none\}/);
  assert.match(source, /\.zu-git-conflict\{color:#f09696\}/);
  assert.match(source, /\.zu-git-warn\{color:#f0e6a0\}/);
  assert.match(source, /\.zu-git-op\{color:#afafb2\}/);
  assert.match(source, /\.zu-git-sep\{opacity:\.6\}/);
  assert.doesNotMatch(source, /\.zu-git\.zu-stale\{opacity/);
  assert.match(source, /@keyframes zugitspin/);
  assert.match(source, /data-k="git"/);
});

test('计数 ≥1万 缩写（v128）：中文万/亿、英文 k/M，<1万原值；aria 保持原值', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const st = gitState({ ahead: 10000, behind: 9999, ins: 15000, del: 10000, untracked: 1000000 });
  const chip = drive(h, ui, st);
  assert.match(chip.innerHTML, /<span class="zu-git-ab">↑1万 ↓9999<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-ins">\+1\.5万<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-del">-1万<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-unt">\?100万<\/span>/);
  assert.match(chip.getAttribute('aria-label'), /改动 \+15000 -10000/, 'aria 播报保持原值');
  h.window.gitTest.state().lang = 'en';
  h.window.__zusageGitState('/repo/a', gitState({ ahead: 10000, behind: 9999, ins: 15000, del: 10000, untracked: 1000000 }));
  assert.match(chip.innerHTML, /<span class="zu-git-ab">↑10k ↓9999<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-ins">\+15k<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-del">-10k<\/span>/);
  assert.match(chip.innerHTML, /<span class="zu-git-unt">\?1M<\/span>/);
});

test('tooltip 行数与条目计数同规则缩写（v128）', () => {
  const h = harness(), ui = h.buildComposer('workspace-main', 'sid_main');
  const chip = drive(h, ui, gitState({ ahead: 123456, behind: 0, ins: 15000, del: 25000, untracked: 10000, staged: 25000, unstaged: 3 }));
  dispatch(chip, 'mouseenter');
  const tip = h.body.children.find(e => e.classList.contains('zusage-git-tip'));
  assert.ok(tip, 'tooltip 挂载');
  assert.match(tip.innerHTML, /\+1\.5万 \/ -2\.5万 行/);
  assert.match(tip.innerHTML, /origin\/main ↑12\.35万/);
  assert.match(tip.innerHTML, /<b>已暂存<\/b><span>2\.5万 项<\/span>/);
  assert.match(tip.innerHTML, /<b>未跟踪<\/b><span>1万 项/);
});
