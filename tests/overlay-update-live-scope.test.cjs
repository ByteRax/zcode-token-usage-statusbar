const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { getNamedSlice } = require('./helpers/overlay-extract.cjs');

// v181 补修锁定：updateLive 的会话均取本 pane 会话行（render 缓存 lastView），
// 不取 payload 顶层 state.data.session（全局最近活跃会话，多窗/分栏会串值）。

function extractUpdateLive() {
  return getNamedSlice('updateLive') + '\nupdateLive;';
}

function runUpdateLive({ lastAvg, payloadAvg, noLastView }) {
  const seen = {};
  const sandbox = {
    L: (zh) => zh,
    Date: { now: () => 1000 },
    state: { rateLine: true, theme: 'compact', data: { session: { avg_tps: payloadAvg } } },
    lastView: noLastView ? undefined : { session: { avg_tps: lastAvg } },
    bridge: { turnId: 'turn_x', timer: null,
      handle: { dead: false, charsPerToken: 2, tracker: { get: () => ({ complete: true }) } } },
    sideHandleValid: () => true,
    bridgeDetach: () => {},
    subRateTick: () => {},
    renderSubAgentRows: () => {},   // v185 并行线：Agent 行内速率 chip 渲染通道
    subRate: { sum: null },
    zuBarSpeedView: (...args) => { seen.args = args; return null; },
    syncTpsChip: () => {},
    liveKindCur: '', liveStatsCur: null,
    render: () => {},
  };
  vm.runInNewContext(extractUpdateLive(), sandbox)();
  return seen.args;
}

test('updateLive 取 lastView.session.avg_tps（本 pane），不取 payload 顶层 session', () => {
  assert.equal(runUpdateLive({ lastAvg: 85.5, payloadAvg: 999 })[3], 85.5);
});

test('updateLive 对缺席/非正数/非有限会话均回退 0', () => {
  for (const v of [undefined, null, 0, -5, NaN, Infinity]) {
    assert.equal(runUpdateLive({ lastAvg: v, payloadAvg: 999 })[3], 0, String(v));
  }
  assert.equal(runUpdateLive({ noLastView: true, payloadAvg: 999 })[3], 0, 'lastView null 时不抛错并回退 0');
});

/* v224 锁定：快速路径的新 tip 串必须写回 .it 格元素（__tip 宿主与 drawTip 读取都在格上）。
 * v218 曾写到格内 .zu-live span——条件每 tick 命中、drawTip 重画的仍是整条渲染时挂在
 * 格上的旧串，悬停中「当前读数」冻结在最后一次整条渲染的值（chip 已跳动、tooltip 停在
 * 「思考中…2秒」）。 */
function runFastPath({ tipForOnCell = true, sameTip = false } = {}) {
  const calls = { draw: [], render: 0 };
  const builtTip = sameTip ? 'TIP:233.6 t/s' : 'TIP:思考中…2秒';   // sameTip=格上已是新签名（不构成变化）
  const cell = { __tip: builtTip };
  const liveEl = { textContent: '', className: '', closest: sel => (sel === '.it' ? cell : null) };
  const view = { cls: 'zu-sky', text: '233.6 t/s', phase: 'generate', band: {} };
  const sandbox = {
    L: (zh) => zh,
    Date: { now: () => 5000 },   // 首拍恒构建（liveTipBuiltAt 初值 -Infinity），与时钟绝对值无关
    state: { rateLine: true, theme: 'default', data: {} },
    lastView: null,
    bridge: { turnId: 'turn_x', timer: null,
      handle: { dead: false, charsPerToken: 2, tracker: { get: () => ({ complete: false }) } } },
    sideHandleValid: () => true,
    bridgeDetach: () => {},
    subRateTick: () => {},
    renderSubAgentRows: () => {},
    subRate: { sum: null },
    zuBarSpeedView: () => view,
    /* v326：updateLive 经 zuLiveFaceHtml 写「数字+dim」两 item——切片环境提供同款实现 */
    zuLiveFaceHtml: (t) => (typeof t === 'string' && / t\/s$/.test(t) ? t.slice(0, -4) + '<span class="dim">t/s</span>' : t),
    buildLiveTip: v => (sameTip ? 'TIP:233.6 t/s' : 'TIP:' + v.text),
    syncTpsChip: () => {},
    liveKindCur: 'live', livePhaseCur: 'generate', liveStatsCur: null,
    liveTextCur: '', liveIconCur: '',
    liveEl, tipFor: tipForOnCell ? cell : { __tip: 'OTHER' },
    drawTip: (...args) => calls.draw.push(args),
    render: () => { calls.render++; },
  };
  vm.runInNewContext(extractUpdateLive(), sandbox)();
  return { calls, cell, liveEl };
}

test('updateLive 快速路径把新 tip 串写回 .it 格元素并重画（v224）', () => {
  const r = runFastPath();
  assert.equal(r.cell.__tip, 'TIP:233.6 t/s');   // 宿主是格元素：drawTip(tipFor) 读的就是它
  assert.deepEqual(r.calls.draw, [[r.cell, true]]);
  assert.equal(r.liveEl.__tip, undefined);       // 回归锁：不得再写格内 .zu-live span
  assert.equal(r.calls.render, 0);               // 快速路径不整条重渲染
});

test('updateLive 快速路径未悬停本格：首拍仍构建并写入 __tip 但不重画；签名不变不重复重画（v328 起后续 1s 内改懒构建，见下）', () => {
  const r = runFastPath({ tipForOnCell: false });
  assert.equal(r.cell.__tip, 'TIP:233.6 t/s');
  assert.deepEqual(r.calls.draw, []);
  assert.deepEqual(runFastPath({ sameTip: true }).calls.draw, []);
});

/* ---- 性能治理（specs/perf-lag-reduction.md §4/§6）：未悬停不白建 tooltip、空闲整条重渲染降频 ---- */
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

function makeLiveEnv({ tipForOnCell = false, tipForOther = false, withView = true, kind = 'live', freshViews = false, nullData = false } = {}) {
  const clock = { now: 1000 };
  const calls = { build: 0, draw: 0, render: 0 };
  const cell = { __tip: 'OLD' };
  const liveEl = { innerHTML: '', className: '', closest: sel => (sel === '.it' ? cell : null) };
  const view = { cls: 'zu-sky', text: '233.6 t/s', phase: 'generate', band: {} };
  const data = nullData ? null : { session: { sid: 's' } };
  const views = [];   // freshViews：每拍一个新 view 对象，用来区分「记最新」与「记首个」
  const sandbox = {
    L: (zh) => zh,
    Date: { now: () => clock.now },
    state: { rateLine: true, theme: 'default', data },
    lastView: null,
    bridge: { turnId: 'turn_x', timer: null,
      handle: { dead: false, charsPerToken: 2, tracker: { get: () => ({ complete: false }) } } },
    sideHandleValid: () => true, bridgeDetach: () => {}, subRateTick: () => {}, renderSubAgentRows: () => {},
    subRate: { sum: null },
    zuBarSpeedView: () => {
      if (!withView) return null;
      if (!freshViews) return view;
      const v = Object.assign({}, view, { seq: views.length });
      views.push(v);
      return v;
    },
    zuLiveFaceHtml: (t) => t,
    buildLiveTip: v => { calls.build++; return 'TIP#' + calls.build; },
    syncTpsChip: () => {},
    liveKindCur: kind, livePhaseCur: 'generate', liveStatsCur: null, liveTextCur: '', liveIconCur: '',
    liveEl, tipFor: tipForOnCell ? cell : (tipForOther ? { __tip: 'OTHER' } : null),
    drawTip: () => { calls.draw++; },
    render: () => { calls.render++; },
  };
  const updateLive = vm.runInNewContext(extractUpdateLive(), sandbox);
  return { updateLive, clock, calls, cell, view, views, sandbox, data };
}

test('updateLive 未悬停本格：1s 内不再每拍构建 tooltip，只记 view 并标失鲜；满 1s 保鲜一次', () => {
  const env = makeLiveEnv({ tipForOnCell: false });
  env.updateLive();                                   // 首拍构建
  assert.equal(env.calls.build, 1);
  assert.equal(env.cell.__tip, 'TIP#1');
  assert.equal(env.cell.__zuTipStale, false);
  for (let i = 1; i <= 9; i++) { env.clock.now = 1000 + i * 100; env.updateLive(); }   // 心跳 10Hz × 0.9s
  assert.equal(env.calls.build, 1, '1s 内心跳全部跳过构建');
  assert.equal(env.cell.__tip, 'TIP#1', '失鲜期间 __tip 不被改写');
  assert.equal(env.cell.__zuTipStale, true);
  assert.equal(env.cell.__zuTipView, env.view);
  assert.equal(env.calls.draw, 0);
  env.clock.now = 2000; env.updateLive();             // 满 1s 保鲜
  assert.equal(env.calls.build, 2);
  assert.equal(env.cell.__tip, 'TIP#2');
  assert.equal(env.cell.__zuTipStale, false);
});

test('updateLive 悬停本格：每拍构建并重画（原 v224 行为不变）', () => {
  const env = makeLiveEnv({ tipForOnCell: true });
  for (let i = 0; i < 5; i++) { env.clock.now = 1000 + i * 100; env.updateLive(); }
  assert.equal(env.calls.build, 5);
  assert.equal(env.calls.draw, 5);
  assert.equal(env.cell.__tip, 'TIP#5');
});

test('liveTipRefresh 补建失鲜 tooltip（drawTip 读取 __tip 前调用），并清失鲜标记', () => {
  const code = sliceOverlay('    function liveTipRefresh(el) {', '    function drawTip(el, keepTop) {');
  const view = { text: 'v' }; let built = null;
  const refresh = vm.runInNewContext(code + '\nliveTipRefresh;', { buildLiveTip: v => { built = v; return 'FRESH'; } });
  const cell = { __tip: 'OLD', __zuTipStale: true, __zuTipView: view };
  refresh(cell);
  assert.equal(built, view);
  assert.equal(cell.__tip, 'FRESH');
  assert.equal(cell.__zuTipStale, false);
  const empty = { __tip: 'KEEP', __zuTipStale: true };           // 无 view：保持原串，只清标记
  refresh(empty);
  assert.equal(empty.__tip, 'KEEP');
  assert.equal(empty.__zuTipStale, false);
  const boom = vm.runInNewContext(code + '\nliveTipRefresh;', { buildLiveTip: () => { throw new Error('x'); } });
  const c3 = { __tip: 'KEEP', __zuTipStale: true, __zuTipView: view };
  assert.doesNotThrow(() => boom(c3));                           // 构建异常不外溢（drawTip 在悬停主链上）
  assert.equal(c3.__tip, 'KEEP');
});

test('drawTip 序言真跑：失鲜格在读取 __tip 之前先补建（注释掉/调换顺序都会红）', () => {
  // 取 drawTip 开头到「!t 则收起」之间的序言（刷新语句 + var t），作为函数体真跑
  const body = sliceOverlay('    function drawTip(el, keepTop) {', '      if (!t) { tip.style.display = "none"; tipFor = null; return; }')
    .replace('    function drawTip(el, keepTop) {', '');
  const prologue = new Function('el', 'liveTipRefresh', body + '\nreturn t;');
  const refresh = (el) => { el.__zuTipStale = false; el.__tip = 'FRESH'; };
  assert.equal(prologue({ __tip: 'OLD', __zuTipStale: true }, refresh), 'FRESH', '失鲜格必须先补建再读取');
  assert.equal(prologue({ __tip: 'OLD', __zuTipStale: false }, refresh), 'OLD', '非失鲜格不触发补建');
  assert.equal(prologue(null, refresh), null, 'el 为空不抛错');
});

test('updateLive 非 live 空闲会话：数据帧未变且 500ms 内不重复整条 render；帧变化/过期/live→非 live 即时', () => {
  const env = makeLiveEnv({ withView: false, kind: 'fallback' });
  env.updateLive();
  assert.equal(env.calls.render, 1, '首拍渲染');
  for (let i = 1; i <= 4; i++) { env.clock.now = 1000 + i * 100; env.updateLive(); }   // 心跳 400ms
  assert.equal(env.calls.render, 1, '同帧 500ms 内不重复渲染');
  env.sandbox.state.data = { session: { sid: 's' } };                                  // 新数据帧（新引用）
  env.clock.now = 1450; env.updateLive();
  assert.equal(env.calls.render, 2, '数据帧引用变化立即渲染');
  env.clock.now = 2000; env.updateLive();
  assert.equal(env.calls.render, 3, '距上次满 500ms 兜底渲染一次');
  env.sandbox.liveKindCur = 'live';                                                     // 刚从 live 退出
  env.clock.now = 2050; env.updateLive();
  assert.equal(env.calls.render, 4, 'live→非 live 切换不受节流');
});

test('updateLive view 非空但尚非 live（进入 live 的结构切换）不受空闲节流', () => {
  const env = makeLiveEnv({ withView: true, kind: 'fallback' });
  env.updateLive(); env.clock.now = 1100; env.updateLive();
  assert.equal(env.calls.render, 2);
});

test('liveTipRefresh 构建失败时保留旧串并留痕 FATAL.liveTipRefreshErr（沙箱无 FATAL 时不抛）', () => {
  const code = sliceOverlay('    function liveTipRefresh(el) {', '    function drawTip(el, keepTop) {') + '\nliveTipRefresh;';
  const FATAL = {};
  const boom = vm.runInNewContext(code, { FATAL, buildLiveTip: () => { throw new Error('boom'); } });
  const cell = { __tip: 'KEEP', __zuTipStale: true, __zuTipView: {} };
  boom(cell);
  assert.equal(cell.__tip, 'KEEP');
  assert.match(FATAL.liveTipRefreshErr, /boom/);
  assert.match(FATAL.liveTipRefreshErr, /\n\s+at /, '留痕应带堆栈（供 diag 定位），而非仅 toString');
});

test('render 整条重挂 __tip 后清除懒构建失鲜标记（失鲜 view 不得在下次 drawTip 覆盖刚建好的新串）', () => {
  const code = sliceOverlay('      for (var i = 0; i < els.length; i++) els[i].__tip = h.tips[i] || null;',
    '      if (didRebuild && focusedIndex >= 0) {');
  const els = [{ __tip: 'OLD0', __zuTipStale: true, __zuTipView: { v: 1 } }, { __zuTipStale: true }];
  vm.runInNewContext(code, { els, h: { tips: ['NEW0'] } });
  assert.equal(els[0].__tip, 'NEW0');
  assert.equal(els[1].__tip, null);
  assert.equal(els[0].__zuTipStale, false);
  assert.equal(els[1].__zuTipStale, false);
});

test('updateLive 失鲜期间 __zuTipView 恒为最新 view（打开瞬间补建必须用此刻的 view，而非首个失鲜拍的）', () => {
  const env = makeLiveEnv({ tipForOnCell: false, freshViews: true });
  env.clock.now = 5000;
  env.updateLive();                                    // 首拍构建
  for (let i = 1; i <= 5; i++) {
    env.clock.now = 5000 + i * 100;
    env.updateLive();
    assert.equal(env.cell.__zuTipView, env.views[env.views.length - 1], `第 ${i} 个失鲜拍记录的必须是该拍的 view`);
    assert.equal(env.cell.__zuTipStale, true);
  }
  assert.notEqual(env.cell.__zuTipView, env.views[0], '不得停留在首拍的 view');
});

test('updateLive 未悬停节流的边界：差 999ms 仍跳过、差 1000ms 即保鲜（<1000，非 <=/不近似）', () => {
  const env = makeLiveEnv({ tipForOnCell: false });
  env.clock.now = 5000;
  env.updateLive();                                    // 5000：构建
  env.clock.now = 5999; env.updateLive();
  assert.equal(env.calls.build, 1, '999ms：跳过');
  env.clock.now = 5950; env.updateLive();
  assert.equal(env.calls.build, 1, '950ms：跳过（阈值不得偏小）');
  env.clock.now = 6000; env.updateLive();
  assert.equal(env.calls.build, 2, '1000ms：保鲜构建');
});

test('updateLive 空闲降频的边界：差 499ms 仍跳过、差 500ms 即渲染', () => {
  const env = makeLiveEnv({ withView: false, kind: 'fallback' });
  env.clock.now = 5000;
  env.updateLive();
  assert.equal(env.calls.render, 1);
  env.clock.now = 5000 + 499; env.updateLive();
  assert.equal(env.calls.render, 1, '499ms：跳过');
  env.clock.now = 5000 + 500; env.updateLive();
  assert.equal(env.calls.render, 2, '恰 500ms：渲染（<500，阈值不得偏大、不得 <=）');
});

test('liveTipRefresh 构建返回空串时保留旧串（不清空 tooltip）', () => {
  const code = sliceOverlay('    function liveTipRefresh(el) {', '    function drawTip(el, keepTop) {') + '\nliveTipRefresh;';
  const refresh = vm.runInNewContext(code, { buildLiveTip: () => '' });
  const cell = { __tip: 'KEEP', __zuTipStale: true, __zuTipView: {} };
  refresh(cell);
  assert.equal(cell.__tip, 'KEEP');
  assert.equal(cell.__zuTipStale, false);
});

test('updateLive 仅「悬停的就是本格」才每拍构建：悬停别的格时本格照常节流', () => {
  const env = makeLiveEnv({ tipForOther: true });
  env.clock.now = 5000;
  env.updateLive();
  for (let i = 1; i <= 5; i++) { env.clock.now = 5000 + i * 100; env.updateLive(); }
  assert.equal(env.calls.build, 1, '别的格悬停不等于本格悬停：1s 内只首拍构建');
  assert.equal(env.calls.draw, 0);
});

test('updateLive 首拍恒构建/渲染，不依赖时钟绝对值（小时钟 + 空数据帧）', () => {
  const a = makeLiveEnv({ tipForOnCell: false });
  a.clock.now = 100;                                   // 小于任何阈值的时钟
  a.updateLive();
  assert.equal(a.calls.build, 1, '首拍必须构建 tooltip');
  const b = makeLiveEnv({ withView: false, kind: 'fallback', nullData: true });
  b.clock.now = 100;
  b.updateLive();
  assert.equal(b.calls.render, 1, '首拍必须渲染（state.data 为 null 的首帧也不被降频吞掉）');
  b.clock.now = 150; b.updateLive();
  assert.equal(b.calls.render, 1, '同一空数据帧 500ms 内允许去重');
});

test('updateLive 找不到 .it 格（closest 返回 null）时连续多拍不抛错，且仍按原逻辑构建 tooltip', () => {
  const env = makeLiveEnv({ tipForOnCell: false });
  env.sandbox.liveEl.closest = () => null;
  env.clock.now = 5000;
  assert.doesNotThrow(() => { env.updateLive(); env.clock.now = 5100; env.updateLive(); env.clock.now = 5200; env.updateLive(); });
  assert.ok(env.calls.build >= 1, '无格元素时不进入节流分支，保持改动前的构建行为');
});
