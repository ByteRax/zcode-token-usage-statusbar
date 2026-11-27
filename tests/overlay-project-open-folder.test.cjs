'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readOverlayPart } = require('./helpers/overlay-extract.cjs');

/* v486 项目菜单「在 Finder 中打开」（specs/project-open-folder-menu.md）：05 分片的菜单扫描、
 * 路径解析（files 项文本 / 行 fiber）、本地项目甄别（data-project-host）、注入幂等、
 * window.zcode.openInFileManager 直调与 dispose。纯渲染端，inject-main 零改动。 */

const SRC = readOverlayPart('05-project-open-folder.js');
const ROW_SEL = '[data-testid="virtual-project-row"]';

/* 极小 DOM 桩：只实现本分片用到的面。选择器支持单个 [attr="v"] / [attr^='v'] / [attr]。 */
class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.dispatched = [];
    this.textContent = '';
  }
  get firstChild() { return this.children[0] || null; }
  get nextElementSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.children.indexOf(this);
    return p.children[i + 1] || null;
  }
  set innerHTML(v) {
    this._html = v;
    const c = new FakeEl('svg');
    c._html = v;   // 产物节点携带同串，供产物链断言
    this.children = [c];
  }
  get innerHTML() { return this._html || ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  cloneNode() {
    const c = new FakeEl(this.tag);
    c.attrs = Object.assign({}, this.attrs);
    c.textContent = this.textContent;
    c.children = this.children.slice();
    c.parentNode = this.parentNode;
    return c;
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatchEvent(ev) {
    this.dispatched.push(ev);
    (this.listeners[ev.type] || []).slice().forEach((fn) => fn(ev));
  }
  click() {
    const ev = { type: 'click', stopPropagation() {}, preventDefault() {} };
    this.dispatchEvent(ev);
    return ev;
  }
  closest(sel) {
    const m = sel.match(/^\[([A-Za-z-]+)(?:="([^"]*)")?\]$/);
    assert.ok(m, 'unexpected closest sel: ' + sel);
    const attr = m[1];
    const want = m[2];
    let p = this;   // 与真实 closest 一致：先看自己（键盘开菜单时 contextmenu 的目标就是行元素本身）
    while (p) {
      const v = p.attrs[attr];
      if (v !== undefined && (want === undefined || v === want)) return p;
      p = p.parentNode;
    }
    return null;
  }
  _matchSel(sel) {
    const m = sel.match(/^\[([A-Za-z-]+)(?:\^?=(?:"([^"]*)"|'([^']*)'))?\]$/);
    assert.ok(m, '不支持的选择器: ' + sel);
    const attr = m[1];
    const want = m[2] !== undefined ? m[2] : m[3];
    const prefix = sel.includes('^=');
    if (want === undefined) return Object.prototype.hasOwnProperty.call(this.attrs, attr);
    const v = this.attrs[attr];
    if (v === undefined) return false;
    return prefix ? v.indexOf(want) === 0 : v === want;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c._matchSel(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

function makeMenu(children, opts) {
  const menu = new FakeEl('div');
  menu.attrs['data-radix-menu-content'] = '';
  menu.attrs.role = 'menu';
  for (const c of children) menu.appendChild(c);
  if (opts && opts.labelledby) menu.attrs['aria-labelledby'] = opts.labelledby;
  return menu;
}
function menuItem(testid, text) {
  const el = new FakeEl('div');
  if (testid) el.attrs['data-testid'] = testid;
  el.attrs.role = 'menuitem';
  el.textContent = text || testid || '';
  return el;
}
/* 本地项目行：section[data-project-host="local"] → row → …（真机 4.0.0 DOM 形态） */
function makeRow(rootPath, hostKind, name) {
  const sec = new FakeEl('section');
  sec.attrs['data-project-host'] = hostKind || 'local';
  const row = new FakeEl('div');
  row.attrs['data-testid'] = 'virtual-project-row';
  if (name) row.textContent = name;
  sec.appendChild(row);
  row['__reactFiber$test'] = {
    memoizedProps: { className: 'x' },
    return: {
      memoizedProps: { project: { roots: [{ rootPath }] } },
      return: null,
    },
  };
  return { sec, row };
}

function makeCtx(opts) {
  opts = opts || {};
  const ctx = {
    menus: opts.menus || [],
    byId: opts.byId || {},
    observers: [],
    rafCbs: [],
    rafCancelled: [],
    docListeners: [],
    opened: [],
    pendingDones: [],
    state: { pluginUpdate: opts.pluginUpdate === undefined ? null : opts.pluginUpdate },
    FATAL: {},
    stale() { return false; },
    L(zh) { return zh; },
    zcode: opts.zcode === undefined
      ? { openInFileManager(p) { ctx.opened.push(p); return Promise.resolve({ success: true }); } }
      : opts.zcode,
    document: {
      body: new FakeEl('body'),
      _menus: null,
      querySelectorAll(sel) {
        if (sel === '[data-radix-menu-content][role="menu"]') return this._menus || ctx.menus;
        throw new Error('unexpected document.querySelectorAll: ' + sel);
      },
      createElement(t) { return new FakeEl(t); },
      createTextNode(s) { const n = new FakeEl('#text'); n.text = s; return n; },
      getElementById(id) { return ctx.byId[id] || null; },
      addEventListener(type, fn, capture) { ctx.docListeners.push({ type, fn, capture }); },
      removeEventListener(type, fn, capture) {
        ctx.docListeners = ctx.docListeners.filter(l => !(l.type === type && l.fn === fn && l.capture === capture));
      },
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; ctx.observers.push(this); }
      observe(target, o) { this.target = target; this.options = o; }
      disconnect() { this.disconnected = true; }
    },
    KeyboardEvent: class {
      constructor(type, init) { this.type = type; this.key = init && init.key; }
    },
    requestAnimationFrame(fn) { ctx.rafCbs.push(fn); return ctx.rafCbs.length; },
    cancelAnimationFrame(id) { ctx.rafCancelled.push(id); },
  };
  ctx.window = { zcode: ctx.zcode };
  ctx.navigator = { userAgent: opts.ua || 'Macintosh; Intel Mac OS X 10_15_7' };   // 真机 mac 分支
  ctx.Date = opts.clock ? { now: () => opts.clock.value } : Date;   // 分片只用 Date.now()：可拨的钟，验证记录有效期
  ctx.document._menus = ctx.menus;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: '05-project-open-folder.js' });
  return ctx;
}

/* 模拟真机右键：捕获阶段 contextmenu 落在行内元素上，分片记录来源行 */
function fireCtxMenu(ctx, insideRow) {
  const handler = ctx.docListeners.find(l => l.type === 'contextmenu');
  assert.ok(handler, 'contextmenu 捕获监听已注册');
  handler.fn({ target: insideRow });
}
/* 按下（捕获阶段 pointerdown）。contextmenu 在 macOS / Linux 于按下时派发、在 Windows 于松开时派发；
 * 菜单何时打开取决于宿主 Radix 的实现（4.0.0 引擎包实证：鼠标右键菜单在 contextmenu 里开）——宿主若换成
 * 按下即开的实现，Windows 上的事件序就是「按下 → 菜单挂载、扫描先跑 → 松开时 contextmenu 后到」。 */
function firePointerDown(ctx, target, button, pointerType) {
  const handler = ctx.docListeners.find(l => l.type === 'pointerdown');
  assert.ok(handler, 'pointerdown 捕获监听已注册');
  handler.fn({ target, button: button === undefined ? 2 : button, pointerType: pointerType || 'mouse' });
}
function runRaf(ctx) { ctx.rafCbs.splice(0).forEach(fn => fn()); }

test('context menu: local project gets an item after each files entry with parsed path', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/proj-a');
  const f1 = menuItem('virtual-project-context-files-1', '查看文件 · /tmp/proj-b');
  const menu = makeMenu([menuItem('virtual-project-context-create-task', '新建任务'), f0, f1, menuItem('virtual-project-worktrees', 'Worktrees')]);
  const { row } = makeRow('/tmp/proj-a');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu] });
  fireCtxMenu(ctx, probe);
  ctx.zuOpfScan();
  const i0 = f0.nextElementSibling;
  const i1 = f1.nextElementSibling;
  assert.ok(i0 && i0.hasAttribute('data-zusage-open-folder'), '第一根后注入');
  assert.ok(i1 && i1.hasAttribute('data-zusage-open-folder'), '第二根后注入');
  assert.equal(i0.attrs['data-testid'], undefined, '宿主 testid 必须剥掉');
  assert.equal(i0.attrs.id, undefined, 'id 必须剥掉');
  assert.equal(i0.children[i0.children.length - 1].text, '在 Finder 中打开');
  assert.equal(i0.children[0].tag, 'svg', '图标在首位');
  assert.ok(i0.children[0].innerHTML.indexOf('folder-open') >= 0);
  i0.click();
  i1.click();
  assert.deepEqual(ctx.opened, ['/tmp/proj-a', '/tmp/proj-b']);
  i0.dispatched.filter(e => e.type === 'keydown').forEach(e => assert.equal(e.key, 'Escape'));
  assert.ok(i0.dispatched.some(e => e.type === 'keydown' && e.key === 'Escape'), '点击后派发 Escape 关菜单');
});

test('context menu: remote project is skipped (data-project-host != local)', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /home/me/proj');
  const menu = makeMenu([f0]);
  const { row } = makeRow('/home/me/proj', 'remote-server');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu] });
  fireCtxMenu(ctx, probe);
  ctx.zuOpfScan();
  assert.equal(f0.nextElementSibling, null);
  assert.deepEqual(ctx.opened, []);
});

test('context menu: no fresh contextmenu record → no injection (fail-closed)', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/proj-a');
  const menu = makeMenu([f0]);
  const ctx = makeCtx({ menus: [menu] });
  ctx.zuOpfScan();
  assert.equal(f0.nextElementSibling, null);
});

test('context menu: rescan does not duplicate; unparseable entries skipped', () => {
  const bad = menuItem('virtual-project-context-files-0', '查看文件');
  const good = menuItem('virtual-project-context-files-1', 'View files · /tmp/ok');
  const menu = makeMenu([bad, good]);
  const { row } = makeRow('/tmp/ok');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu] });
  fireCtxMenu(ctx, probe);
  ctx.zuOpfScan();
  ctx.zuOpfScan();
  assert.equal(bad.nextElementSibling, good, '坏项之间零注入');
  const ok = good.nextElementSibling;
  assert.ok(ok && ok.hasAttribute('data-zusage-open-folder'), '可解析项照常注入');
  assert.equal(menu.querySelectorAll('[data-zusage-open-folder]').length, 1, '重复扫描不重复插入');
  ok.click();
  assert.deepEqual(ctx.opened, ['/tmp/ok']);
});

test('dropdown: labelledby → trigger → local row fiber → roots[0], inserted before Worktrees', () => {
  const { sec, row } = makeRow('/tmp/proj-b');
  const trig = new FakeEl('button');
  trig.attrs.id = 'trig-7';
  row.appendChild(trig);
  const worktrees = menuItem('virtual-project-worktrees', 'Worktrees');
  const menu = makeMenu([worktrees, menuItem('virtual-project-edit', '编辑项目')], { labelledby: 'trig-7' });
  const ctx = makeCtx({ menus: [menu], byId: { 'trig-7': trig } });
  ctx.zuOpfScan();
  const item = menu.querySelector('[data-zusage-open-folder]');
  assert.ok(item, '下拉注入一枚');
  assert.equal(menu.children.indexOf(item), 0, '插在 Worktrees 前');
  item.click();
  assert.deepEqual(ctx.opened, ['/tmp/proj-b']);
  void sec;
});

test('dropdown: remote row → no item even with resolvable fiber', () => {
  const { row } = makeRow('/home/me/proj', 'device-x');
  const trig = new FakeEl('button');
  trig.attrs.id = 'trig-8a';
  row.appendChild(trig);
  const menu = makeMenu([menuItem('virtual-project-worktrees', 'Worktrees')], { labelledby: 'trig-8a' });
  makeCtx({ menus: [menu], byId: { 'trig-8a': trig } });
  assert.equal(menu.querySelector('[data-zusage-open-folder]'), null);
});

test('dropdown: fiber without project roots, or unresolvable labelledby → no item', () => {
  const { sec, row } = makeRow('/tmp/x');
  row['__reactFiber$test'] = { memoizedProps: {}, return: null };
  const trig = new FakeEl('button');
  trig.attrs.id = 'trig-8';
  row.appendChild(trig);
  const menuA = makeMenu([menuItem('virtual-project-worktrees', 'Worktrees')], { labelledby: 'trig-8' });
  const menuB = makeMenu([menuItem('virtual-project-worktrees', 'Worktrees')], { labelledby: 'gone-1' });
  const menuC = makeMenu([menuItem('virtual-project-worktrees', 'Worktrees')]);
  makeCtx({ menus: [menuA, menuB, menuC], byId: { 'trig-8': trig } });
  assert.equal(menuA.querySelector('[data-zusage-open-folder]'), null, 'fiber 无 roots 不注入');
  assert.equal(menuB.querySelector('[data-zusage-open-folder]'), null, 'labelledby 解析不到不注入');
  assert.equal(menuC.querySelector('[data-zusage-open-folder]'), null, '无 labelledby 不注入');
  void sec;
});

test('bridge gate: missing openInFileManager → nothing injected anywhere', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/proj-a');
  const ctxMenu = makeMenu([f0]);
  const { row } = makeRow('/tmp/proj-b');
  const trig = new FakeEl('button');
  trig.attrs.id = 'trig-9';
  row.appendChild(trig);
  const dd = makeMenu([menuItem('virtual-project-worktrees', 'Worktrees')], { labelledby: 'trig-9' });
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [ctxMenu, dd], byId: { 'trig-9': trig }, zcode: {} });
  fireCtxMenu(ctx, probe);
  ctx.zuOpfScan();
  assert.equal(f0.nextElementSibling, null);
  assert.equal(dd.querySelector('[data-zusage-open-folder]'), null);
  assert.deepEqual(ctx.opened, []);
});

test('non-project Radix menus are untouched', () => {
  const menu = makeMenu([menuItem('chat-model-select-item-x', 'GLM-5.4'), menuItem('virtual-other', '其它')]);
  makeCtx({ menus: [menu] });
  assert.equal(menu.querySelectorAll('[data-zusage-open-folder]').length, 0);
  assert.equal(menu.children.length, 2);
});

test('label follows host platform wording (mac/win/other)', () => {
  assert.match(SRC, /在 Finder 中打开/);
  assert.match(SRC, /在文件资源管理器中打开/);
  assert.match(SRC, /在文件管理器中打开/);
  assert.match(SRC, /Open in File Explorer/);
});

test('hover highlight: mouseenter lights ours and clears host items, mouseleave restores off', () => {
  const worktrees = menuItem('virtual-project-worktrees', 'Worktrees');
  worktrees.setAttribute('data-highlighted', '');
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/proj-a');
  const menu = makeMenu([f0, worktrees]);
  const { row } = makeRow('/tmp/proj-a');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu] });
  fireCtxMenu(ctx, probe);
  ctx.zuOpfScan();
  const item = f0.nextElementSibling;
  assert.ok(item && item.hasAttribute('data-zusage-open-folder'), '注入项在场');
  item.dispatchEvent({ type: 'mouseenter' });
  assert.equal(item.hasAttribute('data-highlighted'), true, '悬停自挂 data-highlighted');
  assert.equal(worktrees.hasAttribute('data-highlighted'), false, '宿主项残留高亮被清掉');
  item.dispatchEvent({ type: 'mouseleave' });
  assert.equal(item.hasAttribute('data-highlighted'), false, '移出后自身高亮撤掉');
  assert.equal(ctx.opened.length, 0, '悬停不触发打开');
});

test('observer watches body direct children only; dispose disconnects all wiring', () => {
  const ctx = makeCtx({ menus: [] });
  const mo = ctx.observers[0];
  assert.ok(mo, '观察器已挂');
  assert.equal(mo.target, ctx.document.body);
  assert.deepEqual({ ...mo.options }, { childList: true }, '仅直属子节点，无 subtree');
  assert.equal(ctx.docListeners.filter(l => l.type === 'contextmenu').length, 1, 'contextmenu 捕获监听唯一');
  const down = ctx.docListeners.filter(l => l.type === 'pointerdown');
  assert.equal(down.length, 1, 'pointerdown 捕获监听唯一');
  assert.equal(down[0].capture, true, '右键按下要在宿主的冒泡监听之前记录');
  mo.cb();
  assert.equal(ctx.rafCbs.length, 1, '变更经 rAF 去抖');
  ctx.zuOpfDispose();
  assert.equal(mo.disconnected, true);
  assert.deepEqual(ctx.rafCancelled, [1], '在途 rAF 随 dispose 取消');
  assert.equal(ctx.docListeners.filter(l => l.type === 'contextmenu').length, 0, 'contextmenu 监听随 dispose 摘除');
  assert.equal(ctx.docListeners.filter(l => l.type === 'pointerdown').length, 0, 'pointerdown 监听随 dispose 摘除');
});

test('context menu (Windows order): the right-button press records the row before the menu mounts; a late contextmenu inside the menu keeps it', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · C:\\Users\\me\\proj-a');
  const host = menuItem('virtual-project-worktrees', 'Worktrees');
  const menu = makeMenu([f0, host]);
  const { row } = makeRow('C:\\Users\\me\\proj-a');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu], ua: 'Windows NT 10.0; Win64; x64' });
  firePointerDown(ctx, probe);   // 按下：宿主若在 pointerdown 里就开菜单，菜单挂载触发的扫描先于 contextmenu
  ctx.zuOpfScan();
  const item = f0.nextElementSibling;
  assert.ok(item && item.hasAttribute('data-zusage-open-folder'), '按下时的记录足以注入');
  assert.equal(item.children[item.children.length - 1].text, '在文件资源管理器中打开', 'Windows 文案');
  fireCtxMenu(ctx, host);        // 松开时 contextmenu 后到，指针落在刚弹出的菜单里
  assert.equal(ctx.rafCbs.length, 1, 'contextmenu 之后补排一次扫描');
  menu.removeChild(item);        // 宿主在菜单打开期间重建 items：已注入的项被摘掉
  runRaf(ctx);
  const again = f0.nextElementSibling;
  assert.ok(again && again !== item && again.hasAttribute('data-zusage-open-folder'), '菜单内的 contextmenu 不清记录：补排的扫描把项补回来');
  assert.equal(menu.querySelectorAll('[data-zusage-open-folder]').length, 1, '幂等');
  again.click();
  assert.deepEqual(ctx.opened, ['C:\\Users\\me\\proj-a']);
});

test('context menu: a keyboard-opened menu records the row when the contextmenu target is the row itself', () => {
  // 宿主行 onKeyDown 自派发 contextmenu，目标就是行元素（引擎包实读）
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/proj-a');
  const menu = makeMenu([f0]);
  const { row } = makeRow('/tmp/proj-a');
  const ctx = makeCtx({ menus: [menu] });
  fireCtxMenu(ctx, row);
  runRaf(ctx);
  assert.ok(f0.nextElementSibling && f0.nextElementSibling.hasAttribute('data-zusage-open-folder'), '键盘开菜单照常注入');
});

test('context menu: touch and pen presses record the row (long-press menus open on a timer); a mouse left press does not', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/proj-a');
  const menu = makeMenu([f0]);
  const { row } = makeRow('/tmp/proj-a');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu] });
  firePointerDown(ctx, probe, 0, 'mouse');
  ctx.zuOpfScan();
  assert.equal(f0.nextElementSibling, null, '鼠标左键不记录');
  for (const type of ['touch', 'pen']) {
    firePointerDown(ctx, probe, 0, type);
    ctx.zuOpfScan();
    assert.ok(f0.nextElementSibling && f0.nextElementSibling.hasAttribute('data-zusage-open-folder'), type + ' 按下即记录');
  }
  assert.equal(menu.querySelectorAll('[data-zusage-open-folder]').length, 1);
});

test('context menu: the source-row record expires after 8 seconds', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/proj-a');
  const menu = makeMenu([f0]);
  const { row } = makeRow('/tmp/proj-a');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const clock = { value: 1000000 };
  const ctx = makeCtx({ menus: [menu], clock });
  firePointerDown(ctx, probe);
  clock.value += 7999;
  ctx.zuOpfScan();
  assert.ok(f0.nextElementSibling && f0.nextElementSibling.hasAttribute('data-zusage-open-folder'), '窗口内注入');
  const late = menuItem('virtual-project-context-files-1', '查看文件 · /tmp/proj-b');
  menu.insertBefore(late, null);
  clock.value += 2;   // 过了 8000ms：记录过期，新出现的 files 项不再注入
  ctx.zuOpfScan();
  assert.equal(late.nextElementSibling, null, '过期的记录不注入');
});

test('malformed UNC-looking paths are refused (fail-closed)', () => {
  const texts = ['查看文件 · \\\\srv', 'View files · \\\\\\\\server', '查看文件 · \\\\?\\UNC\\srv\\share\\p', '查看文件 · \\\\?\\C:/x'];
  const menu = makeMenu(texts.map((text, i) => menuItem('virtual-project-context-files-' + i, text)));
  const { row } = makeRow('/tmp/proj-a');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu] });
  fireCtxMenu(ctx, probe);
  ctx.zuOpfScan();
  assert.equal(menu.querySelectorAll('[data-zusage-open-folder]').length, 0);
  assert.deepEqual(ctx.opened, []);
});

test('context menu: a left press does not record; a contextmenu elsewhere clears the record', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/proj-a');
  const menu = makeMenu([f0]);
  const { row } = makeRow('/tmp/proj-a');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu] });
  firePointerDown(ctx, probe, 0);
  ctx.zuOpfScan();
  assert.equal(f0.nextElementSibling, null, '左键不记录来源行');
  firePointerDown(ctx, probe);
  fireCtxMenu(ctx, new FakeEl('main'));
  runRaf(ctx);
  assert.equal(f0.nextElementSibling, null, '别处的右键清掉记录');
});

test('context menu: a contextmenu arriving after the scan re-triggers it', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/proj-a');
  const menu = makeMenu([f0]);
  const { row } = makeRow('/tmp/proj-a');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu] });
  ctx.zuOpfScan();
  assert.equal(f0.nextElementSibling, null, '没有记录时扫描跳过');
  fireCtxMenu(ctx, probe);
  assert.equal(ctx.rafCbs.length, 1, 'contextmenu 记录后补排扫描');
  runRaf(ctx);
  assert.ok(f0.nextElementSibling && f0.nextElementSibling.hasAttribute('data-zusage-open-folder'), '迟到的记录仍能注入');
});

test('windows UNC and long-path roots are accepted from both menu entries', () => {
  const unc = '\\\\srv\\share\\proj';
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · ' + unc);
  const ctxMenu = makeMenu([f0]);
  const trig = new FakeEl('button');
  trig.attrs.id = 'trig-u';
  const dd = makeMenu([menuItem('virtual-project-worktrees', 'Worktrees')], { labelledby: 'trig-u' });
  const { row } = makeRow('\\\\?\\C:\\proj');
  row.appendChild(trig);
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [ctxMenu, dd], byId: { 'trig-u': trig }, ua: 'Windows NT 10.0' });
  fireCtxMenu(ctx, probe);
  ctx.zuOpfScan();
  assert.ok(f0.nextElementSibling && f0.nextElementSibling.hasAttribute('data-zusage-open-folder'), '网络共享做根的项目右键菜单出项');
  f0.nextElementSibling.click();
  const item = dd.querySelector('[data-zusage-open-folder]');
  assert.ok(item, '长路径前缀的根在下拉里出项');
  item.click();
  assert.deepEqual(ctx.opened, [unc, '\\\\?\\C:\\proj']);
});

test('bridge failure reply counts into FATAL.openPathErr without UI error', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/gone');
  const menu = makeMenu([f0]);
  const { row } = makeRow('/tmp/gone');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu], zcode: { openInFileManager() { return Promise.resolve({ success: false, error: 'not found' }); } } });
  fireCtxMenu(ctx, probe);
  ctx.zuOpfScan();
  const item = f0.nextElementSibling;
  item.click();
  return new Promise(r => setImmediate(() => {
    assert.equal(ctx.FATAL.openPathErr.n, 1);
    r();
  }));
});

test('fire-and-forget bridge (null/undefined reply) does not count as failure', () => {
  const f0 = menuItem('virtual-project-context-files-0', '查看文件 · /tmp/ok');
  const menu = makeMenu([f0]);
  const { row } = makeRow('/tmp/ok');
  const probe = new FakeEl('span');
  row.appendChild(probe);
  const ctx = makeCtx({ menus: [menu], zcode: { openInFileManager() { return Promise.resolve(null); } } });
  fireCtxMenu(ctx, probe);
  ctx.zuOpfScan();
  f0.nextElementSibling.click();
  return new Promise(r => setImmediate(() => {
    assert.equal(ctx.FATAL.openPathErr, undefined, 'null 回执不计数');
    r();
  }));
});
