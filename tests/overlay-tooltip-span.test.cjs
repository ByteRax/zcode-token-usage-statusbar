const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const helpers = source.slice(source.indexOf('    function fmtStart('), source.indexOf('    function ioc(')) +
  source.slice(source.indexOf('    function ttEsc('), source.indexOf('    function stubFor('));

function render(data, lang = 'zh', live = null) {
  const context = vm.createContext({
    state: { lang, show: { turn: true, win: true, today: true } },
    L: (zh, en) => lang === 'en' ? en : zh,
    fmt: value => String(value || 0), sec: value => String(value || 0),
    cachePct: () => '', shrink: false, liveStatsCur: live, bridge: { handle: null },
    zuBarSpeedView: value => value, zuIcoThinking: () => '<svg/>',
  });
  vm.runInContext(helpers, context);
  return context.html(data).tips.filter(Boolean);
}

function fixture() {
  const start = new Date(2026, 9, 19, 13, 42).getTime();
  const end = new Date(2026, 9, 19, 13, 43).getTime();
  return {
    session: { started: start, last_at: end },
    last: { tps: 102.2, startedAt: start, endedAt: end },
    last_turn: { requests: 2, output: 452, duration_ms: 16173, tps: 102.2, unrated_output: 11, started: start, ended: end },
    today: { started: start, last_at: end },
  };
}

test('tooltip uses supplied weighted rate and complete local date ranges in both languages', () => {
  for (const lang of ['zh', 'en']) {
    const tips = render(fixture(), lang);
    const turn = tips.find(tip => tip.includes(lang === 'zh' ? '本轮 ·' : 'Latest turn ·'));
    assert.match(turn, /102\.2 tok\/s/);
    assert.doesNotMatch(turn, /27\.9 tok\/s/);
    assert.match(turn, lang === 'zh' ? /11 token 未参与测速/ : /11 tokens excluded from rate/);
    assert.equal(tips.filter(tip => tip.includes('2026-10-19 13:42 - 2026-10-19 13:43')).length, 4);
  }
});

test('old remote payloads and unavailable rates do not fall back to total duration', () => {
  for (const tps of [undefined, null, 0, NaN, Infinity, '102.2']) {
    const data = fixture();
    data.last_turn.tps = tps;
    const turn = render(data).find(tip => tip.includes('本轮 ·'));
    assert.doesNotMatch(turn, /输出速度|27\.9 tok\/s/);
    assert.match(turn, /时间范围/);
  }
});

test('missing endpoints remain unavailable and live speed does not borrow a DB sample range', () => {
  const data = fixture();
  data.last.endedAt = 0;
  const db = render(data).find(tip => tip.includes('生成速度 · 最近一段'));
  assert.match(db, /2026-10-19 13:42 - —/);
  const live = render(data, 'zh', { phase: 'writing', text: '12 t/s', cls: 'dim' })[0];
  assert.match(live, /renderer/);
  assert.doesNotMatch(live, /2026-10-19|生成速度 · 最近一段/);
});
