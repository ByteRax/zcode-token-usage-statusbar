const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

/* v300「会话累计」tooltip 450 自适应紧凑布局（参考本轮 v299 同款三行 KPI）：
 * 行一 总用量|输入(缓存徽标随标签)|输出(含思考)；行二 会话级耗时（zusage 聚合，
 * >0 门控）；行三 平均输出速度(会话均 avg_tps 档色)|预估费用；规模行/模型表/时间行。
 * 样式 :has(.zu-stat-tip--session) 作用域隔离。 */

const helpers = sliceOverlay('    function fmtStart(', '    function ioc(') +
  sliceOverlay('    function ttEsc(', '    function stubFor(');
const bandHelpers = sliceOverlay('  var TPS_BANDS = [', '  /* 返回 null = 调用方应把这当成');

function render(data, lang = 'zh', cost = 1) {
  const context = vm.createContext({
    state: { lang, cost, show: { turn: true, win: true, today: true } },
    L: (zh, en) => lang === 'en' ? en : zh,
    fmt: value => String(value || 0), countFmt: value => String(value || 0), sec: value => String(value || 0), secLong: value => String(value || 0),
    cachePct: () => '', shrink: false, liveStatsCur: null, bridge: { handle: null },
    subRate: { rate: null, at: 0 },
    zuBarSpeedView: value => value, zuIcoThinking: () => '<svg/>',
    lastView: { last: { tps: 102.2 } },
    speedChartHover: -1, speedTipSess: '', speedTipRebuild: null,
    FXQ_ICON: '<svg class="tip-fxq"></svg>',
  });
  vm.runInContext(bandHelpers, context);
  vm.runInContext(helpers, context);
  return context.html(data).tips.filter(Boolean).find(t => t.includes('zu-stat-tip--session'));
}

function sessionFixture(over) {
  const start = new Date(2026, 10, 8, 20, 42, 28).getTime();
  const end = new Date(2026, 10, 8, 20, 46, 14).getTime();
  const entry = {
    sid: 'sess_main',
    total: 426000000, input: 425000000, output: 590000, cache_read: 416500000, reasoning: 120000,
    avg_tps: 144.1, avg_duration_ms: 6500, avg_ttft_ms: 3200, duration_ms: 226500,
    started: start, last_at: end, cost_usd: 255.39, turns: 628, requests: 17,
    tool_calls: 16, retries: 1,
    models: [{ model: 'GLM-5.3-FlashX', requests: 17, total: 426000000, cost_usd: 255.39,
      rates: { input: 0.002, output: 0.008 } }],
  };
  if (over) Object.assign(entry, over);
  /* 生产视图：view.session = p = recent[0] 整个会话快照——富字段必须在 session 对象上 */
  return {
    session: Object.assign({ project: 'Demo 项目' }, entry),
    last: { tps: 156.1, startedAt: start, endedAt: end },
    recent: [entry],
    today: { started: start, last_at: end },
  };
}
const noStyle = s => s.replace(/<style>[\s\S]*?<\/style>/g, '');
const stripAll = s => noStyle(s).replace(/<[^>]+>/g, '');
const ruleBodies = style => style.replace(/^<style>/, '').replace(/<\/style>$/, '').split('}');

test('v300 session tip: 450 wide auto-height scoped style, per-rule hygiene', () => {
  const style = (render(sessionFixture()).match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  assert.match(style, /zusage-tip-root:has\(\.zu-stat-tip--session\)\{width:min\(450px,calc\(100vw - 16px\)\)!important/);
  assert.match(style, /max-height:calc\(100vh - 24px\)!important/);
  assert.doesNotMatch(style, /:has\(\.zu-stat-tip--session\)\{[^}]*height:\d/);   // 高度自适应不写定高
  for (const r of ruleBodies(style)) {
    const sel = r.split('{')[0].trim();
    if (!sel) continue;
    assert.ok(/zu-turn-|^\.zu-stat-tip--session|:has\(\.zu-stat-tip--session\)/.test(sel), '越域选择器: ' + sel);
    if (/^\.zusage-tip-root:has\(\.zu-stat-tip--session\)\{/.test(sel) ||
        /^\.zusage-tip-root:has\(\.zu-stat-tip--session\) \.tbody\{/.test(sel)) {
      assert.doesNotMatch(r, /display/, 'tip/tbody 禁注入 display');
    }
  }
});

test('v300 session tip: three KPI rows in fixed order with session metrics', () => {
  const text = stripAll(render(sessionFixture()));
  const idx = ['总用量', '输入', '输出', '请求次数', '请求轮数', '请求会话',
    '平均耗时', '平均延迟', '总耗时', '平均输出速度', '预估费用']
    .map(k => text.indexOf(k));
  for (let i = 0; i < idx.length - 1; i++) assert.ok(idx[i] >= 0 && idx[i] < idx[i + 1], '行序错: ' + i);
  assert.match(noStyle(render(sessionFixture())), /zu-turn-kpis--mid/, '耗时行容器');
  assert.match(noStyle(render(sessionFixture())), /zu-turn-kpis--duo/, '速度行容器（v302 两列）');
  assert.match(text, /426000000/, '会话级数值（VM 桩 fmt 直出）');
  // v302 行二数值：请求次数=17、请求轮数=628、请求会话=项目缺失显 —
  const raw2 = noStyle(render(sessionFixture()));
  assert.match(raw2, /请求次数<\/div><div class="zu-stat-v">17<\/div>/);
  assert.match(raw2, /请求轮数<\/div><div class="zu-stat-v">628<\/div>/);
  assert.match(raw2, /请求会话<\/div><div class="zu-stat-v">—</);
});

test('v302 session tip: 11 KPI label icons aligned with turn card', () => {
  const raw = render(sessionFixture());
  assert.equal((noStyle(raw).match(/zu-kpi-ico/g) || []).length, 11, '会话卡图标恰 11 枚（3+3+3+2）');
  // 规模行：请求=纸飞机、轮数=气泡、会话=文件夹；耗时行沙漏沿用
  assert.match(raw, /zu-kpi-ico[^]*?<\/svg>请求轮数</);
  assert.ok(raw.includes('M7.9 20A9 9 0 1 0 4 16.1L2 22Z'), '轮数气泡路径');
  assert.ok(raw.includes('m22 2-7 20-4-9-9-4Z'), '请求纸飞机路径');
  assert.ok(raw.includes('M7.5 3h12a2 2 0 0 1 2 2v10'), '会话文件夹路径');
  assert.ok(raw.includes('M5 22h14'), '总耗时沙漏路径');
});

test('v300 session tip: cache badge on input label row (short label)', () => {
  const raw = noStyle(render(sessionFixture()));
  assert.match(raw, /<span class="hit zu-turn-hit">缓存98%<\/span>/);
  assert.ok(raw.indexOf('>输入<span class="hit') >= 0, '徽标紧跟输入标签');
});

test('v300 session tip: avg output speed banded (session avg, not last turn)', () => {
  const raw = render(sessionFixture());
  assert.match(raw, /平均输出速度/);
  assert.match(raw, /<b class="ok">144\.1<\/b> <small>t\/s<\/small>/);
});

test('v300 session tip: scale row kept, models honest, timing degradation', () => {
  const tip = noStyle(render(sessionFixture()));
  // v302：轮对话以「请求轮数」升为行二第二列独立 KPI
  assert.match(tip, /<\/svg>请求轮数<\/div><div class="zu-stat-v">628<\/div>/, '请求轮数=行二独立格');
  assert.doesNotMatch(tip, /zu-stat-scale|轮对话/, '旧轮对话标签与规模行已删');
  const duoIdx = tip.indexOf('请求轮数'), spIdx = tip.indexOf('>平均输出速度<');
  assert.ok(duoIdx >= 0 && duoIdx < spIdx, '请求轮数列在平均输出速度列之前');
  assert.match(tip, /工具调用 16 次[\s\S]*?重试 1 次/, '工具调用/重试并入模型明细标题行右侧（同本轮）');
  assert.match(tip, /zu-turn-models/, '模型表在独立滚动区');
  const noModels = noStyle(render(sessionFixture({ models: [] })));
  assert.doesNotMatch(noModels, /模型明细|zu-pj-mhead|zu-turn-models/, '无模型不渲染空表');
  const oldSnap = noStyle(render(sessionFixture({
    avg_duration_ms: undefined, avg_ttft_ms: undefined, duration_ms: undefined, avg_tps: undefined,
  })));
  assert.doesNotMatch(oldSnap, /zu-turn-kpis--mid/, '耗时字段缺失=行二收起');
  assert.match(oldSnap, /平均输出速度<\/div><div class="zu-stat-v">—</);
  assert.match(tip, /2026-11-08 20:42:28 — 2026-11-08 20:46:14/, '秒级时间范围');
});

test('v300 session tip: cost gating collapses fee everywhere; locale stable', () => {
  const off = stripAll(render(sessionFixture(), 'zh', 0));
  assert.doesNotMatch(off, /预估费用/);
  assert.match(off, /平均输出速度/, '速度格仍在');
  const en = stripAll(render(sessionFixture(), 'en'));
  assert.match(en, /Session total/);
  assert.match(en, /Avg output rate/);
  assert.match(en, /cache\s*98%/);   // en 文案带尾随空格
});

test('review fix: explicit zeros degrade honestly (session avg_tps 0 → —, duration 0 → mid row collapses)', () => {
  const zeroTps = noStyle(render(sessionFixture({ avg_tps: 0 })));
  assert.match(zeroTps, /平均输出速度<\/div><div class="zu-stat-v">—</, 'avg_tps 0 renders — (real zusage zero-rated-segments shape)');
  assert.doesNotMatch(zeroTps, />0(\.0)?<\/b> <small>t\/s</, 'no fake 0 t/s reading');
  const zeroDur = noStyle(render(sessionFixture({ avg_duration_ms: 0, avg_ttft_ms: 0, duration_ms: 0 })));
  assert.doesNotMatch(zeroDur, /zu-turn-kpis--mid/, 'all-zero durations collapse the mid row (undefined-only coverage before)');
});
