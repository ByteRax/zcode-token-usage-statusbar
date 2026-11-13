/* mobile-relay 主进程模块的 chips 口径锁（specs/mobile-relay.md「速度主数字」）。
 * 桌面 v298（用户拍板）：状态条速度主数字 = 最后一轮真实速度（快照 last.tps），
 * 会话加权平均 avg_tps 只进 tooltip。手机端必须同口径，否则远控页面显示
 * 157.2t/s 而桌面显示 355t/s（本次实机回归的根因）。 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { chipsFromSession, tpsBand } = require('../mobile-relay.cjs');

const record = {
  last: { tps: 355.0 },
  avg_tps: 157.2,
  last_turn: { total: 17149, requests: 1 },
  total: 297285, turns: 16, requests: 21, tool_calls: 5,
  project: { total: 297285, sessions: 1, requests: 21 },
  sub: { total: 1807866, requests: 22 },   // 0.2.4 起照抄桌面：子代理格
};
const today = { total: 120065217, turns: 72, requests: 625 };

test('speed chip uses latest-segment real tps, not session average', () => {
  const chips = chipsFromSession(record, today);
  const speed = chips.find(c => c.id === 'speed');
  assert.ok(speed, 'speed chip present');
  assert.equal(speed.value, '355t/s', 'v298：主数字取 last.tps');
  assert.match(speed.detail, /会话均 157\.2t\/s/, '会话均只进 tooltip detail');
});

test('speed chip falls back to avg_tps only when latest segment is missing', () => {
  const chips = chipsFromSession({ ...record, last: { tps: 0 } }, today);
  assert.equal(chips.find(c => c.id === 'speed').value, '157.2t/s');
});

test('speed band follows TPS_BANDS thresholds', () => {
  assert.equal(tpsBand(355), 'zu-azure');    // 300–500 高速
  assert.equal(tpsBand(157.2), 'zu-teal');   // 150–200 较快
  assert.equal(tpsBand(65), 'warm');
  assert.equal(tpsBand(20), 'hot');
  assert.equal(tpsBand(0), 'hot');
  assert.equal(tpsBand(NaN), '');
});

test('chips keep desktop order and use desktop state.show keys', () => {
  const chips = chipsFromSession(record, today);
  assert.deepEqual(chips.map(c => c.id), ['speed', 'turn', 'win', 'today', 'proj', 'sub', 'tools']);
  assert.equal(chips.find(c => c.id === 'turn').value, '1.71万1次');
  assert.equal(chips.find(c => c.id === 'win').value, '29.73万16轮 21次');
  assert.equal(chips.find(c => c.id === 'today').value, '1.2亿72轮 625次');
  assert.equal(chips.find(c => c.id === 'proj').value, '29.73万1会话 21次');
  assert.equal(chips.find(c => c.id === 'sub').value, '180.79万22次');   // 0.2.4 起照抄桌面：子代理格
});

test('a fresh session without data emits no speed chip (no zero-value fabrication)', () => {
  const chips = chipsFromSession({ last: { tps: 0 }, avg_tps: 0, total: 0, turns: 0, requests: 0 }, null);
  assert.equal(chips.find(c => c.id === 'speed'), undefined);
});
