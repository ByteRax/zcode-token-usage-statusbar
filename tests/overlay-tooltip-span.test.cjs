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
    state: { lang, cost: 1, show: { turn: true, win: true, today: true, ...(show || {}) } },   // cost:1 = 真实默认开（buildProjectTipHTML/costTipRow 门控读它）
    L: (zh, en) => lang === 'en' ? en : zh,
    fmt: value => String(value || 0), countFmt: value => String(value || 0), sec: value => String(value || 0),
    cachePct: () => '', shrink: false, liveStatsCur: live, bridge: { handle: null },
    subRate: { rate: null, at: 0 },   // v97：html 里子代理估算桥引用（值本身被 zuBarSpeedView stub 吞掉）
    zuBarSpeedView: value => value, zuIcoThinking: () => '<svg/>',
    /* v218：buildLiveTip 右格改读泵快照最近一段（lastView.last.tps）——切片注入 */
    lastView: { last: { tps: 102.2 } },
    /* v232：html() 读写实例闭包的速度柱状图悬停状态——切片沙箱按初值注入同形种子 */
    speedChartHover: -1, speedTipSess: '', speedTipRebuild: null,
    FXQ_ICON: '<svg class="tip-fxq"></svg>',   // v214 模块级常量不在切片内，行为测试用桩
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
    const turn = tips.find(tip => tip.includes('zu-stat-tip--turn'));
    assert.match(turn, /102\.2 <small>t\/s<\/small>/);
    assert.doesNotMatch(turn, /27\.9 (?:tok|t)\/s/);
    assert.doesNotMatch(turn.replace(/<[^>]+>/g, ''), /未参与测速|excluded from rate/);   // v253 口径行已删（unrated_output 字段照旧生产，仅不再展示）
    // v210：全部时间范围行精确到秒（v166 先行会话/项目累计，本轮/今日合计/速率最近一段跟进；
    // 本用例未开 proj 开关，项目累计 tip 不渲染，共 4 处）
    assert.equal(tips.filter(tip => tip.includes('2026-10-19 13:42:00 — 2026-10-19 13:43:00')).length, 4);
    assert.equal(tips.filter(tip => /2026-10-19 13:4[23][^:]/.test(tip)).length, 0);   // 到分旧格式清零
  }
});

test('old remote payloads and unavailable rates do not fall back to total duration', () => {
  for (const tps of [undefined, null, 0, NaN, Infinity, '102.2']) {
    const data = fixture();
    data.last_turn.tps = tps;
    const turn = render(data).find(tip => tip.includes('zu-stat-tip--turn'));
    assert.doesNotMatch(turn, /27\.9 tok\/s/);
    assert.match(turn, /zu-stat-tip--turn/);
    assert.match(turn, /时间范围/);
  }
});

test('missing endpoints remain unavailable and live speed does not borrow a DB sample range', () => {
  const data = fixture();
  data.last.endedAt = 0;
  const db = render(data, 'zh').find(tip => tip.includes('zu-stat-tip--speed'));
  assert.match(db, /2026-10-19 13:42:00 — —/);
  const live = render(data, 'zh', { phase: 'writing', text: '12 t/s', cls: 'dim' })[0];
  assert.match(live, /renderer/);
  assert.doesNotMatch(live, /2026-10-19 13:42/);   // live 态不得借用 DB 采样时间/范围
});

test('v214 project total card: KPI/details/scale/models table/time, bilingual', () => {
  const data = fixture();
  data.session.project = {
    sessions: 3, turns: 12, requests: 45, input: 6000, output: 700, reasoning: 200,
    cache_read: 5000, cache_write: 30, total: 6700, tool_calls: 9, retries: 2,
    started: data.session.started, last_at: data.session.last_at,
    cost_usd: 12.5,
    models: [{ model: 'GLM-5.3', requests: 40, total: 6000, cost_usd: 12 }, { model: 'gpt-6.1-sol', requests: 5, total: 700, cost_usd: 0.5 }],
  };
  const zh = render(data, 'zh', null, { proj: true }).find(tip => tip.includes('zu-project-tip'));
  console.error('SPANPJ:' + String(zh).slice(0, 700));
  const strip = s => s.replace(/<[^>]+>/g, '');
  // 标题与统计范围
  assert.match(zh, /zu-pj-title">项目累计</);
  assert.match(zh, /zu-pj-scope">全部请求</);
  assert.match(strip(zh), /含子代理/);
  // 三项核心指标（费用 0 有效、缺失显 — 均由 typeof 判断承载）
  assert.match(strip(zh), /总用量\s*6700/);
  assert.match(strip(zh), /请求次数\s*45/);
  assert.match(strip(zh), /预估费用[^]*?\$12\.50/);
  // 用量明细：命中率绿色强调、含思考次级
  assert.match(strip(zh), /输入\s*6000\s*缓存命中率 83%/);
  assert.match(zh, /zu-pj-hit">缓存命中率 83%</);
  assert.match(strip(zh), /输出\s*700\s*含思考 200/);
  assert.match(strip(zh), /缓存写入\s*30/);
  // 运行规模（含子代理已在标题区，不重复）
  assert.match(strip(zh), /3 会话\s*·\s*12 轮\s*·\s*工具 9 次\s*·\s*重试 2 次/);
  assert.doesNotMatch(strip(zh).split('含子代理')[1] || '', /含子代理/);
  // 模型明细四列表格（2 模型 ≤6 全显，无展开按钮）
  assert.match(zh, /zu-pj-table/);
  assert.match(strip(zh), /模型\s*Token 用量 ↓\s*请求次数\s*预估费用/);
  assert.match(strip(zh), /GLM-5\.3\s*6000\s*40\s*\$12\.00/);
  assert.match(strip(zh), /gpt-6\.1-sol\s*700\s*5\s*\$0\.50/);
  assert.doesNotMatch(zh, /zu-pj-more/);   // N<=6 无展开按钮
  // 时间范围：em dash、精确到秒
  assert.match(zh, /2026-10-19 13:42:00 — 2026-10-19 13:43:00/);
  const en = render(data, 'en', null, { proj: true }).find(tip => tip.includes('zu-project-tip'));
  assert.match(en, /zu-pj-title">Project total</);
  assert.match(en, /zu-pj-scope">All requests</);
  assert.match(strip(en), /Total tokens\s*6700/);
  assert.match(strip(en), /incl\. 200/);
  assert.match(strip(en), /3 sessions\s*·\s*12 turns/);
  assert.doesNotMatch(en, /Show all/);   // N<=6 无展开按钮（英文同链）
});

test('v163 session total card: per-model table rows from snapshot models', () => {
  const data = fixture();
  data.session.total = 1250300;
  data.session.models = [{ model: 'GLM-5.3', requests: 180, total: 1200000 }, { model: '', requests: 7, total: 300 }];
  const zh = render(data, 'zh', null, { proj: false }).find(tip => tip.includes('zu-stat-tip--session'));
  const strip = s => s.replace(/<[^>]+>/g, '');
  assert.match(strip(zh), /总用量\s*1250300/);
  assert.match(zh, /zu-pj-time/);
  assert.match(zh, /2026-10-19 13:42:00 — 2026-10-19 13:43:00/);   // v166 精确到秒 + em dash
  assert.match(strip(zh), /GLM-5\.3\s*1200000\s*180/);
  assert.match(strip(zh), /未知模型\s*300\s*7/);
  // 无 models 字段（轻量行/旧快照）：模型明细块降级但不报错
  const bare = render(fixture(), 'zh', null, { proj: false }).find(tip => tip.includes('zu-stat-tip--session'));
  assert.ok(bare, 'session card renders');
  assert.doesNotMatch(bare, /未知模型/);
});

test('v159 project cell hidden without toggle or without snapshot field', () => {
  const data = fixture();
  data.session.project = { sessions: 3, requests: 45, total: 6700 };
  assert.equal(render(data, 'zh', null, {}).find(tip => tip.includes('项目累计')), undefined);
  assert.equal(render(fixture(), 'zh', null, { proj: true }).find(tip => tip.includes('项目累计')), undefined);
});

test('v246 turn/today cards lead with total tokens and the tools table dims sub-0.1s durations', () => {
  const data = fixture();
  Object.assign(data.last_turn, { total: 752, input: 300, cache_read: 250 });
  Object.assign(data.today, { total: 900, input: 600, cache_read: 450, output: 300, reasoning: 50, retries: 1, requests: 5 });
  data.tools = { total: 3, errors: 0, list: [
    { name: 'Bash', count: 2, duration_ms: 20, errors: 0 },
    { name: 'Read', count: 1, duration_ms: 1500, errors: 0 },
  ] };
  const strip = s => s.replace(/<[^>]+>/g, '');
  const turn = render(data).find(tip => tip.includes('zu-stat-tip--turn'));
  assert.match(strip(turn), /总用量\s*752/, '本轮首格=总用量（回退「请求次数」即红）');
  assert.match(turn, /缓存命中率 83%/, '本轮输入行副行=命中率');
  assert.doesNotMatch(strip(turn), /请求次数/);   // 请求次数只在标题徽标，不再占 KPI 首格
  const today = render(data).find(tip => tip.includes('zu-stat-tip--today'));
  assert.match(strip(today), /总用量\s*900/, '今日首格=总用量');
  assert.match(today, /缓存命中率 75%/, '今日命中率并入 grid3 输入列副行');
  const tools = render(data, 'zh', null, { tools: true }).find(tip => tip.includes('zu-stat-tip--tools'));
  assert.match(tools, /<td class="dim0">&lt;0\.1s<\/td>/, '工具表 <50ms 显「<0.1s」并弱化');
  assert.match(tools, /<td>1500<\/td>/, '正常耗时不带弱化');
});
