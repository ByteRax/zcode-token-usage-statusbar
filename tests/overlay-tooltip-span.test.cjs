const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const helpers = source.slice(source.indexOf('    function fmtStart('), source.indexOf('    function ioc(')) +
  source.slice(source.indexOf('    function ttEsc('), source.indexOf('    function stubFor('));
// v127：DB 回退分支的档位行动态调用 tpsBand/tpsBandText——注入真实分档表（不含
// zuBarSpeedView，它仍由各用例的桩覆盖），保证 tooltip 内容按真实档位生成。
const bandHelpers = source.slice(source.indexOf('  var TPS_BANDS = ['), source.indexOf('  /* 返回 null = 调用方应把这当成'));

function render(data, lang = 'zh', live = null, show = null) {
  const context = vm.createContext({
    state: { lang, show: { turn: true, win: true, today: true, ...(show || {}) } },
    L: (zh, en) => lang === 'en' ? en : zh,
    fmt: value => String(value || 0), sec: value => String(value || 0),
    cachePct: () => '', shrink: false, liveStatsCur: live, bridge: { handle: null },
    subRate: { rate: null, at: 0 },   // v97：html 里子代理估算桥引用（值本身被 zuBarSpeedView stub 吞掉）
    zuBarSpeedView: value => value, zuIcoThinking: () => '<svg/>',
  });
  vm.runInContext(bandHelpers, context);
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
    assert.match(turn.replace(/<[^>]+>/g, ''), lang === 'zh' ? /11 token 未参与测速/ : /11 tokens excluded from rate/);
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

test('v159 project total cell: beside session total, sub-agent note, bilingual', () => {
  const data = fixture();
  data.session.project = {
    sessions: 3, turns: 12, requests: 45, input: 6000, output: 700, reasoning: 200,
    cache_read: 5000, cache_write: 30, total: 6700, tool_calls: 9, retries: 2,
    started: data.session.started, last_at: data.session.last_at,
    models: [{ model: 'GLM-5.3', requests: 40, total: 6000 }, { model: 'gpt-6.1-sol', requests: 5, total: 700 }],
    models_more: 2,
  };
  const zh = render(data, 'zh', null, { proj: true }).find(tip => tip.includes('项目累计 · 全部请求'));
  const strip = s => s.replace(/<[^>]+>/g, '');
  assert.match(strip(zh), /3 会话 · 12 轮 · 45 次请求/);
  assert.match(strip(zh), /含子代理/);
  assert.match(strip(zh), /命中 83%/);
  assert.match(strip(zh), /缓存写入/);
  assert.match(strip(zh), /GLM-5\.3\s*6000 token · 40次/);
  assert.match(strip(zh), /gpt-6\.1-sol\s*700 token · 5次/);
  assert.match(strip(zh), /另有 2 个模型/);
  assert.match(zh, /2026-10-19 13:42 - 2026-10-19 13:43/);
  const en = render(data, 'en', null, { proj: true }).find(tip => tip.includes('Project total · all requests'));
  assert.match(strip(en), /3 sessions · 12 turns · 45 requests/);
  assert.match(strip(en), /incl\. sub-agents/);
  assert.match(strip(en), /2 more models/);
});

test('v163 session total tooltip lists per-model rows from snapshot models', () => {
  const data = fixture();
  data.session.models = [{ model: 'GLM-5.3', requests: 180, total: 1200000 }, { model: '', requests: 7, total: 300 }];
  const zh = render(data, 'zh').find(tip => tip.includes('会话累计 · 全部请求'));
  const strip = s => s.replace(/<[^>]+>/g, '');
  assert.match(strip(zh), /GLM-5\.3\s*1200000 token · 180次/);
  assert.match(strip(zh), /未知模型\s*300 token · 7次/);
  // 无 models 字段（轻量行/旧快照）不显示模型行也不报错
  const bare = render(fixture(), 'zh').find(tip => tip.includes('会话累计 · 全部请求'));
  assert.doesNotMatch(bare, /未知模型/);
});

test('v159 project cell hidden without toggle or without snapshot field', () => {
  const data = fixture();
  data.session.project = { sessions: 3, requests: 45, total: 6700 };
  assert.equal(render(data, 'zh', null, {}).find(tip => tip.includes('项目累计')), undefined);
  assert.equal(render(fixture(), 'zh', null, { proj: true }).find(tip => tip.includes('项目累计')), undefined);
});
