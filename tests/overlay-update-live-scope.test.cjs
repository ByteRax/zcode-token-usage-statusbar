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
    Date: { now: () => 1000 },
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

test('updateLive 快速路径未悬停本格时仍保持 __tip 新鲜但不重画；签名不变不重复重画', () => {
  const r = runFastPath({ tipForOnCell: false });
  assert.equal(r.cell.__tip, 'TIP:233.6 t/s');
  assert.deepEqual(r.calls.draw, []);
  assert.deepEqual(runFastPath({ sameTip: true }).calls.draw, []);
});
