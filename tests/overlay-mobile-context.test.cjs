'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { SRC_DIR, readOverlayPart, sliceOverlay } = require('./helpers/overlay-extract.cjs');

const part = name => `src/overlay/${name}`;
const slice = (file, start, end) => sliceOverlay(start, end, { file: part(file) });
const BOOT = '00-boot-state-i18n.js';
const RENDER = '07-instance-render-and-tips.js';
const BRIDGE = '08-instance-bridge-and-subrate.js';
const MOUNT = '12-instance-mount-and-boot.js';
const contextSource = slice(BOOT, '  function mobileContext(', '  function sessionFor(');
const updateSource = slice(BOOT, '  window.__zusageUpdate =', '  window.__zusagePluginRequests');
const selectSource = slice(BRIDGE, '    var mobileViewKey =', '      excOn = excActive(p);');
const viewSource = slice(BRIDGE, '      var myTarget = p.remote_target || "";', '      /* 只切换实际显隐');
const htmlSource = slice(RENDER, '    function html(d) {', '    /* 当前会话识别');
const helpers = slice(RENDER, '    function fmt(n, count)', '    /* 档位表') +
  slice(RENDER, '    function fmtTime(ms)', '    /* ---------- v202 预估费用') +
  slice(RENDER, '    function turnVBkt(', '    /* v202 本轮/今日 tooltip');

function fixture(mobileMode = true) {
  const calls = { desktop: 0, guess: 0, hides: 0, themes: 0, closed: 0 };
  const s = {
    window: { __zusageSpdSticky: { turns: ['desktop-history'] } },
    state: { show: { win: 1, turn: 1, today: 1, sub: 1, tools: 1, proj: 1 }, theme: 'default' },
    mobileMode, mobileBinding: '', lastSpeedHistory: { turns: ['desktop-history'] },
    remoteCache: { previous: { total: 900 } }, remoteTodayCache: { previous: { total: 800 } },
    instances: [], FATAL: {}, stale: () => false, instSid: 'task-a', pickedSid: '', pid: 'workspace-main',
    windowScope: null, nativeCtxVal: 0, main: { children: [] },
    liveStatsCur: null, liveKindCur: '', livePhaseCur: '', liveIconCur: '',
    speedSel: { range: 'all', period: 'all', dim: 'project' }, speedTipSess: 'old', speedChartHover: 9,
    speedTipRebuild: () => 'old', projTipKey: 'old', projTipPj: {}, projTipList: [],
    tipStats: {}, subPanel: {}, mobileViewKey: '', lastSub: null, lastView: null,
    hideTip: () => calls.hides++, subPopClose: () => calls.closed++, restoreTpsChip() {},
    bar: { classList: { contains: () => false } }, applyBarTheme: () => calls.themes++,
    sessionFor: (d, sid) => { calls.desktop++; return (d.recent || []).find(r => r.sid === sid); },
    pickCurrent: () => { calls.guess++; return null; }, stubFor: sid => ({ sid, total: 0, requests: 0 }),
    L: (zh) => zh, cnUnits: () => false, shrink: 0, bridge: { handle: null }, subRate: { sum: {} },
    cellsAllOff: () => false, zuBarSortItems: rows => rows, statCompactStyle: () => '', statHead: () => '', kpiIco: () => '',
    statModelsTable: () => '', fxqIcon: () => '', countFmt: String, speedSegsOf: () => [],
    tpsBand: () => ({ cls: 'ok' }), tpsBandText: () => '', speedCardHTML: () => '',
    buildProjectTipHTML: () => '', escAttr: v => String(v),   // v412：statKpi title 兜底引用
    STAT_TIP_W: { turn: 540, session: 600, today: 600, project: 760, tools: 450 },   // v412：卡根 data-zu-w 取值
  };
  const ctx = vm.createContext(s);
  vm.runInContext(contextSource + updateSource + helpers + '\nfunction ico() { return ""; }\n' + htmlSource, ctx);
  vm.runInContext(selectSource + '      return {p:p,mobile:mobile};\n    }', ctx);
  function select(d, sid = ctx.instSid) {
    ctx.instSid = sid;
    return ctx.render(d);
  }
  function view(d, sid = ctx.instSid) {
    const selected = select(d, sid);
    ctx.p = selected.p; ctx.mobile = selected.mobile; ctx.d = d;
    vm.runInContext(viewSource, ctx);
    return ctx.view;
  }
  return { ctx, calls, select, view, html: d => ctx.html(view(d)), update: d => ctx.window.__zusageUpdate(d) };
}
function frame({ taskId = 'task-a', binding = 'binding-a', scopeKind = 'local', state = 'ready', row = {}, today = {} } = {}) {
  const session = { sid: taskId, ...row };
  if (scopeKind === 'remote') session.remote = true;
  return { mine: taskId, mobile: { taskId, binding, scopeKind, state }, recent: [session], session, today };
}
const numbers = total => ({ total, input: total, output: 0, cache_read: 0, turns: 1, requests: 1 });

test('mobile mode selects only the bound frame without desktop heuristics or unknown-field leakage', () => {
  const h = fixture();
  const d = frame({ row: numbers(41), today: numbers(71) });
  d.mobile.future = { taskId: 'other', today: numbers(999) };
  const v = h.view(d);
  assert.equal(v.session.total, 41);
  assert.equal(v.today.total, 71);
  assert.equal(v.mobile.state, 'ready');
  assert.equal(h.calls.desktop, 0); assert.equal(h.calls.guess, 0);
  h.ctx.instSid = '';
  assert.equal(h.view(d, '').session.sid, 'task-a');
});

test('page SID changes before the next frame immediately render the same-bar waiting state with no old today', () => {
  const h = fixture(), d = frame({ row: numbers(4141), today: numbers(7171) });
  h.view(d);
  const v = h.view(d, 'task-b');
  assert.equal(v.mobile.state, 'waiting');
  assert.equal(v.session.sid, 'task-b');
  assert.equal(v.today.total, undefined);
  assert.equal(v.session.total, undefined);
  const html = h.ctx.html(v);
  assert.match(html.s, /等待当前会话数据/);
  assert.doesNotMatch(html.s, /4141|7171|zu-sub/);
  assert.equal(h.calls.desktop, 0);
});

test('invalid bindings, ambiguous rows and mismatched remote provenance fail closed', () => {
  const h = fixture();
  for (const mutate of [
    d => { d.mobile.binding = ''; }, d => { d.mobile.binding = 'bad/path'; },
    d => { d.mobile.binding = 'x'.repeat(129); }, d => { d.mobile.taskId = 'x'.repeat(129); },
    d => { d.mobile.scopeKind = 'unknown'; }, d => { d.mobile.state = 'unknown'; },
    d => { d.mine = 'other'; }, d => { d.session = {}; },
    d => { d.recent.push({ sid: 'task-a', total: 900 }); },
    d => { d.recent[0].remote = true; },
    d => { d.recent[0].workspace_identity = 'remote:server:secret'; },
    d => { d.recent[0].remote_target = 'secret'; },
  ]) {
    const d = frame(); mutate(d);
    assert.notEqual(h.view(d).mobile.state, 'ready');
  }
  for (const binding of ['a', 'a-B_09', 'f'.repeat(32), 'x'.repeat(128)]) {
    assert.equal(h.view(frame({ binding })).mobile.state, 'ready');
  }
});

test('same SID with a new binding clears remote caches and instance tip state', () => {
  const h = fixture();
  const a = frame({ row: { ...numbers(100), last: { tps: 31 } } });
  a.speed_history = { turns: ['mobile-a'] };
  h.update(a); h.view(a);
  assert.equal(a.speed_history.turns[0], 'mobile-a');
  h.ctx.remoteCache.old = {}; h.ctx.remoteTodayCache.old = {};
  h.ctx.speedChartHover = 8; h.ctx.speedSel.range = 'all';
  const before = h.calls.hides;
  const b = frame({ binding: 'binding-b', row: { ...numbers(200), last: { tps: 32 } } });
  h.update(b); const v = h.view(b);
  assert.equal(v.session.total, 200);
  assert.equal(b.speed_history, undefined);
  assert.deepEqual(Object.keys(h.ctx.remoteCache), []);
  assert.deepEqual(Object.keys(h.ctx.remoteTodayCache), []);
  assert.equal(h.ctx.speedChartHover, -1);
  assert.equal(h.ctx.speedSel.range, 'recent');
  assert.ok(h.calls.hides > before);
  assert.equal(h.ctx.speedTipRebuild, null);
});

test('remote mobile today uses the current projected today without a real remote_target or cache fallback', () => {
  const h = fixture();
  const d = frame({ scopeKind: 'remote', row: numbers(7), today: numbers(18) });
  d.remote_today = { previous: numbers(999) };
  h.update(d);
  const v = h.view(d);
  assert.equal(v.remote, true); assert.equal(v.today.total, 18);
  assert.equal(v.session.workspace_identity, undefined); assert.equal(v.session.remote_target, undefined);
  assert.equal(h.ctx.remoteTodayCache.previous, undefined);
  delete d.today;
  assert.equal(h.view(d).today, undefined);
  d.mobile.state = 'unavailable';
  assert.equal(h.view(d).today.total, undefined);
});

test('mobile empty states and incomplete ready frames never fabricate zero cells', () => {
  const h = fixture();
  for (const [state, text] of [['waiting', /等待/], ['unavailable', /不可用/], ['upgrade', /请更新桌面插件/]]) {
    const d = frame({ state }); d.session = {}; d.recent = [];
    const result = h.html(d);
    assert.match(result.s, text);
    assert.doesNotMatch(result.s, /class="v">0|zu-sub|工具调用/);
  }
  const unknown = h.html(frame());
  assert.match(unknown.s, /暂无统计数据/);
  assert.doesNotMatch(unknown.s, /class="v">0|zu-sub/);
  const known = h.html(frame({ row: { ...numbers(0), tools: { total: 0, errors: 0, list: [] },
    sub: { total: 0, input: 0, output: 0, cache_read: 0, requests: 0, list: [] } }, today: numbers(0) }));
  assert.match(known.s, /class="v">0/);
  assert.match(known.s, /zu-sub/);
  const incomplete = h.html(frame({ row: { ...numbers(9), tools: {}, sub: {} }, today: numbers(10) }));
  assert.doesNotMatch(incomplete.s, /zu-sub/);
  assert.ok(incomplete.tips.every(t => !t || !t.includes('zu-stat-tip--tools')));
});

test('legacy frames without a target show the upgrade prompt with a selected page session', () => {
  const h = fixture();
  const d = { session: {}, recent: [], mine: '', mobile: {
    taskId: '', binding: '', scopeKind: '', state: 'upgrade',
  } };
  const upgrade = h.ctx.html(h.view(d, 'task-a'));
  assert.match(upgrade.s, /请更新桌面插件/);
  assert.doesNotMatch(upgrade.s, /class="v">0/);

  d.mobile.taskId = 'task-b';
  const waiting = h.ctx.html(h.view(d, 'task-a'));
  assert.match(waiting.s, /等待当前会话数据/);
  assert.doesNotMatch(waiting.s, /请更新桌面插件/);
});

test('ordinary desktop ignores mobile metadata and retains zero values and sticky fallback', () => {
  const h = fixture(false), d = frame({ state: 'upgrade', row: numbers(0), today: numbers(0) });
  h.update(d);
  assert.equal(d.speed_history.turns[0], 'desktop-history');
  const v = h.view(d);
  assert.equal(v.mobile, undefined);
  assert.equal(v.session.total, 0);
  assert.equal(h.calls.desktop, 1);
  const html = h.ctx.html(v);
  assert.match(html.s, /class="v">0/);
  assert.match(html.s, /zu-sub/);
  assert.doesNotMatch(html.s, /请更新桌面插件|等待当前会话/);
});

test('mobile compact empty state exposes the original bar and preserves the selected theme', () => {
  const h = fixture();
  vm.runInContext(slice(MOUNT, '    function mobileEmpty()', '    function applyBarTheme()'), h.ctx);
  h.ctx.state.theme = 'compact'; h.ctx.state.data = frame({ state: 'waiting' });
  assert.equal(h.ctx.compactBarHidden(), false);
  h.ctx.state.data = frame();
  assert.equal(h.ctx.compactBarHidden(), true);
  h.ctx.instSid = 'task-b';
  assert.equal(h.ctx.compactBarHidden(), false);
  assert.equal(h.ctx.state.theme, 'compact');
  h.ctx.mobileMode = false;
  assert.equal(h.ctx.compactBarHidden(), true);
});

function currentSource() {
  return fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js')).sort().map(f => readOverlayPart(f)).join('\n');
}
function mountedFixture(theme = 'default', mobile = true) {
  const declarations = sliceOverlay('class Element {', "test('coordinator quota", { file: 'tests/overlay-lifecycle.test.cjs' });
  const tools = vm.runInNewContext(declarations + '\n({harness})', { vm, console, source: currentSource() });
  const store = new Map([['zusage3.theme', theme]]);
  const h = tools.harness({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) });
  h.window.__zusageMobileMode = mobile;
  h.setPanes(['a'], { toolbar: true }); h.inject(); h.boot();
  const all = () => h.body.children.concat(...h.body.children.map(e => e.children));
  const bar = () => all().find(e => /zusage-root/.test(e.className || ''));
  return { ...h, store, bar, api: () => h.window.lifecycleTest.instances()[0] };
}

test('mounted mobile empty bar keeps its original gear/settings and restores compact on ready', () => {
  const h = mountedFixture('compact');
  let bar = h.bar();
  assert.ok(bar, 'original desktop bar remains mounted');
  assert.equal(bar.classList.contains('zu-compact'), false);
  const main = bar.querySelector('.zu-main'), gear = bar.querySelector('.zu-gear');
  assert.match(main.innerHTML, /等待当前会话/);
  const panel = h.body.children.find(e => /zusage-panel/.test(e.className || '') && !/sub/.test(e.className || ''));
  panel.querySelector('.zu-navitem[aria-current="page"]').focus = () => {};
  for (const fn of gear.listeners.get('click') || []) fn({ stopPropagation() {} });
  assert.equal(panel.classList.contains('open'), true);
  const ready = frame({ taskId: 'sid_a', row: numbers(11), today: numbers(22) });
  h.window.__zusageUpdate(ready);
  bar = h.bar();
  assert.equal(bar.classList.contains('zu-compact'), true);
  assert.equal(bar.style.display, 'none');
  ready.mobile.state = 'unavailable'; ready.recent = []; ready.session = {};
  h.window.__zusageUpdate(ready);
  assert.equal(bar.classList.contains('zu-compact'), false);
  assert.notEqual(bar.style.display, 'none');
  assert.match(main.innerHTML, /不可用/);
  assert.equal(h.store.get('zusage3.theme'), 'compact');
  assert.equal(h.window.__zusageDiag.updateErr, undefined);
  h.window.__zusageDispose();
});

test('mobile mode does not start the 10Hz bridge heartbeat', () => {
  /* 移动端只消费中继投影帧：不绑本页 store，也不启动 100ms 桥心跳（空转唤醒）。 */
  const mobile = mountedFixture('default', true);
  assert.equal([...mobile.timers.values()].filter(t => t.interval && t.ms === 100).length, 0);
  mobile.window.__zusageDispose();
  assert.equal(mobile.timers.size, 0);

  const desktop = mountedFixture('default', false);
  assert.equal([...desktop.timers.values()].filter(t => t.interval && t.ms === 100).length, 1);
  desktop.window.__zusageDispose();
});

test('current source fragments parse together without generating build artifacts', () => {
  assert.doesNotThrow(() => new vm.Script(currentSource(), { filename: path.join(SRC_DIR, '(memory overlay)') }));
});

test('mobile frames never write or sticky-restore desktop speed history', () => {
  /* v377：粘性轮表是桌面速度 Tooltip 的跨代缓存；移动模式不得写入（907 的 !isMobile），
   * 也不得在缺字段帧用它回补（911 的 !isMobile），否则桌面历史会漏进手机 V2 卡。
   * 变异实验：删掉任一 !isMobile 门，本用例即红。 */
  const h = fixture(true);
  const desktopHistory = { turns: ['desktop-history'] };
  h.ctx.lastSpeedHistory = desktopHistory;
  h.ctx.window.__zusageSpdSticky = desktopHistory;
  const mobile = frame({ row: numbers(50) });
  mobile.speed_history = { turns: ['mobile-a'] };
  h.update(mobile);
  assert.equal(h.ctx.lastSpeedHistory, desktopHistory, 'mobile ready frame must not overwrite sticky history');
  assert.equal(h.ctx.window.__zusageSpdSticky, desktopHistory, 'mobile frame must not publish sticky history');

  const gap = frame({ row: numbers(60) });   // 缺 speed_history：桌面会走 sticky 回补，移动不会
  delete gap.speed_history;
  h.update(gap);
  assert.equal(gap.speed_history, undefined, 'mobile frame must not sticky-restore desktop history');

  // 同一夹具切到桌面：写入与 sticky 回补都应生效（证明不是断言写死）
  h.ctx.mobileMode = false;
  const desktop = frame({ row: numbers(70) });
  desktop.speed_history = { turns: ['desktop-new'] };
  h.update(desktop);
  assert.equal(h.ctx.lastSpeedHistory, desktop.speed_history, 'desktop frame still writes sticky history');
  const desktopGap = frame({ row: numbers(80) });
  delete desktopGap.speed_history;
  h.update(desktopGap);
  assert.equal(desktopGap.speed_history, desktop.speed_history, 'desktop frame sticky-restores on gap');
});
