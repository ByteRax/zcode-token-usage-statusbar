const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// v181 补修锁定：updateLive 的会话均取本 pane 会话行（render 缓存 lastView），
// 不取 payload 顶层 state.data.session（全局最近活跃会话，多窗/分栏会串值）。
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

function extractUpdateLive() {
  const start = source.indexOf('    function updateLive() {');
  const end = source.indexOf('    /* v90：心跳', start);
  assert.ok(start >= 0 && end > start, '提取失败: updateLive');
  return source.slice(start, end) + '\nupdateLive;';
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
